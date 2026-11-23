require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// MongoDB Atlas connection
const MONGO_URI =
  process.env.MONGO_URI ||
  'mongodb+srv://13yougames_db_user:ThirteenYou6978@cluster0.pgdm4sz.mongodb.net/13you_db?retryWrites=true&w=majority';

mongoose
  .connect(MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.log('MongoDB connection note:', err.message));

// OTP Flow config
const OTPFLOW_API_KEY = (process.env.OTPFLOW_API_KEY || '').trim();
const OTPFLOW_SEND_URL = 'https://otpflow.in/send-otp';
const OTPFLOW_VERIFY_URL = 'https://otpflow.in/verify-otp';

// Email transporter setup (Gmail SMTP with App Password)
let mailTransporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER.trim(),
      pass: process.env.EMAIL_PASS.trim().replace(/\s+/g, '')
    }
  });
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Accepts "DD/MM/YYYY", "DD-MM-YYYY", or "YYYY-MM-DD"
function parseDob(dobStr) {
  if (!dobStr || typeof dobStr !== 'string') return null;
  const trimmed = dobStr.trim();

  const dmyMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10) - 1;
    const year = parseInt(dmyMatch[3], 10);
    const date = new Date(year, month, day);
    if (date.getFullYear() === year && date.getMonth() === month && date.getDate() === day) {
      return date;
    }
    return null;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function calculateAge(dobDate) {
  if (!dobDate) return -1;
  const today = new Date();
  let age = today.getFullYear() - dobDate.getFullYear();
  const monthDiff = today.getMonth() - dobDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dobDate.getDate())) {
    age--;
  }
  return age;
}

function getDefaultAdultDob() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 20);
  return d;
}

function getBaseServerUrl(req) {
  if (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.trim()) {
    return process.env.PUBLIC_BASE_URL.trim().replace(/\/+$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

function normalizeIndianPhone(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return digits.slice(1);
  }
  return digits;
}

async function callOtpFlowSend({ number, purpose = 'login', ttl = 10, otpLength = 6 }) {
  if (!OTPFLOW_API_KEY) {
    throw new Error('OTPFLOW_API_KEY is missing in environment variables');
  }

  const res = await fetch(OTPFLOW_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OTPFLOW_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      number,
      purpose,
      ttl,
      otp_length: otpLength
    })
  });

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function callOtpFlowVerify({ otpId, otp }) {
  if (!OTPFLOW_API_KEY) {
    throw new Error('OTPFLOW_API_KEY is missing in environment variables');
  }

  const res = await fetch(OTPFLOW_VERIFY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OTPFLOW_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      otp_id: otpId,
      otp: String(otp).trim()
    })
  });

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function sendApprovalEmailViaBrevo({ toEmail, approveUrl, appName }) {
  const apiKey = (process.env.BREVO_API_KEY || '').trim();
  const senderEmail = (process.env.SENDER_EMAIL || process.env.EMAIL_USER || '').trim();
  const senderName = (process.env.SENDER_NAME || appName || '13 You Games').trim();

  if (!apiKey || !senderEmail) {
    return false;
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: [{ email: toEmail }],
      subject: `${appName} - Confirm your login`,
      htmlContent: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #141414; color: #ffffff; border-radius: 10px;">
          <h2 style="margin-top: 0; color: #f5c542;">${appName} Login Request</h2>
          <p>Someone requested to log into <b>${appName}</b> using <b>${toEmail}</b>.</p>
          <p>If this was you, tap the button below to approve your login:</p>
          <p style="margin: 24px 0;">
            <a href="${approveUrl}" style="display: inline-block; padding: 12px 22px; background: #f5c542; color: #111111; text-decoration: none; font-weight: bold; border-radius: 6px;">
              Yes, it's me
            </a>
          </p>
          <p style="font-size: 12px; color: #aaaaaa;">This link expires in 10 minutes. If you did not request this, ignore this email.</p>
        </div>
      `
    })
  });

  return res.ok;
}

// cleanPhone -> { otpId, purpose, expiresAt }
const otpStore = new Map();
// token -> { email, status: 'pending' | 'approved', expiresAt, userId }
const emailApprovalStore = new Map();
// roomId -> array of chat messages
const chatRoomsStore = new Map();

function getKeywordFallbackReply(userMsg) {
  const q = String(userMsg || '').toLowerCase();
  if (q.includes('withdraw')) {
    return 'Minimum withdrawal Rs. 500 hai. UPI ya Bank details sahi bhar kar submit karein.';
  }
  if (q.includes('deposit') || q.includes('add') || q.includes('utr') || q.includes('qr')) {
    return 'Add Cash mein QR/UPI se payment karke UTR submit karein, verify hote hi balance update ho jaayega.';
  }
  if (q.includes('how to play') || q.includes('game') || q.includes('rule') || q.includes('khele')) {
    return 'Lobby se game ya cricket mode chunein, apna stake/bet lagayein aur live round ka result dekhein.';
  }
  return 'Aapka message mil gaya hai. Support team jald hi aapki query check karegi.';
}

async function getSupportAutoReply(userMsg) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return getKeywordFallbackReply(userMsg);
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `You are a helpful customer support assistant for "13 YOU GAMES" (a mobile card/cricket game app with welcome bonus Rs. 50, minimum withdrawal Rs. 500, UPI/Bank withdrawal, Add Cash via QR/UTR, bonus, referral, promocode). Reply concisely, politely, and in simple Hinglish/Hindi matching the user's language. User message: ${userMsg}`
                }
              ]
            }
          ]
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('[Gemini API error]:', response.status, errText);
      return getKeywordFallbackReply(userMsg);
    }

    const data = await response.json();
    const reply =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    return (reply && reply.trim()) || getKeywordFallbackReply(userMsg);
  } catch (err) {
    console.error('[Gemini fetch failed]:', err.message);
    return getKeywordFallbackReply(userMsg);
  }
}

const transactionSchema = new mongoose.Schema({
  type: { type: String, enum: ['credit', 'debit'], required: true },
  amount: { type: Number, required: true },
  reason: { type: String, default: 'game' },
  createdAt: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema(
  {
    firebaseUid: { type: String, unique: true, sparse: true },
    phone: { type: String, unique: true, sparse: true, default: undefined },
    passwordHash: { type: String },
    email: { type: String, default: '', lowercase: true, trim: true },
    name: { type: String, required: true },
    dob: { type: Date, default: getDefaultAdultDob },
    isAdultVerified: { type: Boolean, default: false },
    balance: { type: Number, default: 50, min: 0 },
    transactions: [transactionSchema]
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);

function formatUserResponse(user) {
  return {
    id: user._id.toString(),
    name: user.name || '',
    dob: user.dob ? user.dob.toISOString() : '',
    isAdultVerified: Boolean(user.isAdultVerified),
    phone: user.phone || '',
    email: user.email || '',
    balance: Number(user.balance || 0)
  };
}

app.get('/', (req, res) => {
  res.json({ status: 'OK', message: '13 You Games Server is running!' });
});

// 1. Send SMS OTP via OTP Flow (works for both signup & login)
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const cleanPhone = normalizeIndianPhone(req.body && (req.body.phone || req.body.number));
    const purpose = String((req.body && req.body.purpose) || 'login').trim() || 'login';

    if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Valid 10-digit Indian mobile number required'
      });
    }

    const { ok, status, data } = await callOtpFlowSend({
      number: cleanPhone,
      purpose,
      ttl: 10,
      otpLength: 6
    });

    if (!ok || !data || data.success === false || !data.otp_id) {
      console.error('[send-otp provider error]:', status, data);
      return res.status(status >= 400 ? status : 400).json({
        success: false,
        message: (data && (data.message || data.error)) || 'Failed to send OTP via OTP Flow'
      });
    }

    const expiresAt = data.expires_at ? new Date(data.expires_at).getTime() : Date.now() + 10 * 60 * 1000;
    otpStore.set(cleanPhone, {
      otpId: data.otp_id,
      purpose,
      expiresAt: Number.isNaN(expiresAt) ? Date.now() + 10 * 60 * 1000 : expiresAt
    });

    return res.json({
      success: true,
      message: data.message || 'OTP sent successfully',
      expires_at: data.expires_at || null
    });
  } catch (err) {
    console.error('[send-otp error]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 1B. Verify SMS OTP via OTP Flow & Login / Create User
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const cleanPhone = normalizeIndianPhone(req.body && (req.body.phone || req.body.number));
    const otp = req.body && req.body.otp ? String(req.body.otp).trim() : '';
    const name = req.body && req.body.name ? String(req.body.name).trim() : '';
    const dob = req.body && req.body.dob ? String(req.body.dob).trim() : '';
    const email = req.body && req.body.email ? String(req.body.email).trim().toLowerCase() : '';

    if (!/^[6-9]\d{9}$/.test(cleanPhone) || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Valid 10-digit phone number and OTP are required'
      });
    }

    const record = otpStore.get(cleanPhone);
    if (!record || !record.otpId) {
      return res.status(400).json({
        success: false,
        message: 'No active OTP session found. Click Get OTP first.'
      });
    }

    if (Date.now() > record.expiresAt) {
      otpStore.delete(cleanPhone);
      return res.status(400).json({
        success: false,
        message: 'OTP expired. Click Get OTP again.'
      });
    }

    const { ok, status, data } = await callOtpFlowVerify({
      otpId: record.otpId,
      otp
    });

    if (!ok || !data || data.success === false) {
      return res.status(status >= 400 ? status : 400).json({
        success: false,
        message: (data && (data.message || data.error)) || 'Invalid OTP'
      });
    }

    otpStore.delete(cleanPhone);

    let user = await User.findOne({ phone: cleanPhone });
    let isNewUser = false;

    if (!user) {
      let parsedDob = getDefaultAdultDob();
      if (dob) {
        const checkDob = parseDob(dob);
        if (!checkDob) {
          return res.status(400).json({
            success: false,
            message: 'Invalid DOB format. Use DD/MM/YYYY'
          });
        }
        if (calculateAge(checkDob) < 18) {
          return res.status(400).json({
            success: false,
            message: '18+ age required to sign up'
          });
        }
        parsedDob = checkDob;
      }

      isNewUser = true;
      user = await User.create({
        name: name || `Player_${cleanPhone.slice(-4)}`,
        dob: parsedDob,
        isAdultVerified: true,
        phone: cleanPhone,
        email,
        balance: 50,
        transactions: [{ type: 'credit', amount: 50, reason: 'welcome_bonus' }]
      });
    } else if (email && !user.email) {
      user.email = email;
      await user.save();
    }

    return res.json({
      success: true,
      message: data.message || 'OTP verified',
      isNewUser,
      user: formatUserResponse(user)
    });
  } catch (err) {
    console.error('[verify-otp error]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Sign-Up with Name + DOB (18+) + Phone + Password + Optional Gmail + OTP
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, dob, phone, password, email, otp } = req.body;

    if (!name || !name.trim() || !dob || !phone || !password || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Name, DOB, phone, password and OTP are required'
      });
    }

    const parsedDob = parseDob(dob);
    if (!parsedDob) {
      return res.status(400).json({ success: false, message: 'Invalid DOB format. Use DD/MM/YYYY' });
    }

    const age = calculateAge(parsedDob);
    if (age < 18) {
      return res.status(400).json({ success: false, message: '18+ age required to sign up' });
    }

    const cleanPhone = normalizeIndianPhone(phone);
    if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian mobile number required' });
    }

    const existing = await User.findOne({ phone: cleanPhone });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Account already exists' });
    }

    const record = otpStore.get(cleanPhone);
    if (!record || !record.otpId || Date.now() > record.expiresAt) {
      if (record) otpStore.delete(cleanPhone);
      return res.status(400).json({ success: false, message: 'OTP expired. Click Get OTP again.' });
    }

    const { ok, status, data } = await callOtpFlowVerify({
      otpId: record.otpId,
      otp: otp.toString().trim()
    });

    if (!ok || !data || data.success === false) {
      return res.status(status >= 400 ? status : 400).json({
        success: false,
        message: (data && (data.message || data.error)) || 'Invalid OTP'
      });
    }

    otpStore.delete(cleanPhone);

    const user = await User.create({
      name: name.trim(),
      dob: parsedDob,
      isAdultVerified: true,
      phone: cleanPhone,
      passwordHash: hashPassword(password),
      email: email ? email.trim().toLowerCase() : '',
      balance: 50,
      transactions: [{ type: 'credit', amount: 50, reason: 'welcome_bonus' }]
    });

    res.json({
      success: true,
      message: 'Sign up successful',
      user: formatUserResponse(user)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Login with Phone + Password
app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'Phone and password are required' });
    }

    const cleanPhone = normalizeIndianPhone(phone);
    const user = await User.findOne({ phone: cleanPhone });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found. Please Sign Up.' });
    }

    if (!user.passwordHash || user.passwordHash !== hashPassword(password)) {
      return res.status(401).json({ success: false, message: 'Wrong password' });
    }

    res.json({
      success: true,
      message: 'Login successful',
      user: formatUserResponse(user)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3A. Request Email Approval Link ("Yes, it's me")
app.post('/api/auth/email-request', async (req, res) => {
  try {
    const rawEmail = req.body && req.body.email ? String(req.body.email).trim().toLowerCase() : '';
    if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      return res.status(400).json({ success: false, message: 'Valid email address required' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const approveUrl = `${getBaseServerUrl(req)}/api/auth/email-approve?token=${token}`;

    emailApprovalStore.set(token, {
      email: rawEmail,
      status: 'pending',
      expiresAt,
      userId: null
    });

    const appName = process.env.APP_NAME || '13 You Games';
    const sentViaBrevo = await sendApprovalEmailViaBrevo({
      toEmail: rawEmail,
      approveUrl,
      appName
    });

    if (!sentViaBrevo) {
      if (mailTransporter) {
        await mailTransporter.sendMail({
          from: `"${appName}" <${process.env.EMAIL_USER.trim()}>`,
          to: rawEmail,
          subject: `${appName} - Confirm your login`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #141414; color: #ffffff; border-radius: 10px;">
              <h2 style="margin-top: 0; color: #f5c542;">${appName} Login Request</h2>
              <p>Someone requested to log into <b>${appName}</b> using <b>${rawEmail}</b>.</p>
              <p>If this was you, tap the button below to approve your login:</p>
              <p style="margin: 24px 0;">
                <a href="${approveUrl}" style="display: inline-block; padding: 12px 22px; background: #f5c542; color: #111111; text-decoration: none; font-weight: bold; border-radius: 6px;">
                  Yes, it's me
                </a>
              </p>
              <p style="font-size: 12px; color: #aaaaaa;">This link expires in 10 minutes. If you did not request this, ignore this email.</p>
            </div>
          `
        });
      } else {
        console.log(`[Email Approval Link for ${rawEmail}]: ${approveUrl}`);
      }
    }

    res.json({
      success: true,
      message: 'Approval email sent',
      token
    });
  } catch (err) {
    console.error('[email-request error]:', err);
    res.status(500).json({ success: false, message: 'Failed to send approval email' });
  }
});

// 3B. Approval Page ("Yes, it's me")
app.get('/api/auth/email-approve', async (req, res) => {
  const token = req.query && req.query.token ? String(req.query.token).trim() : '';
  const record = token ? emailApprovalStore.get(token) : null;

  if (!record || Date.now() > record.expiresAt) {
    if (token) emailApprovalStore.delete(token);
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;background:#111;color:#fff;text-align:center;padding:50px;">
        <h2>Link Expired or Invalid</h2>
        <p>Please go back to the game and request a new login link.</p>
      </body></html>
    `);
  }

  return res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Confirm Login</title>
      <style>
        body { font-family: Arial, sans-serif; background: #111; color: #fff; text-align: center; padding: 48px 20px; }
        .box { max-width: 420px; margin: 0 auto; background: #1c1c1c; padding: 28px; border-radius: 12px; border: 1px solid #333; }
        button { padding: 14px 26px; font-size: 16px; font-weight: bold; background: #f5c542; color: #111; border: none; border-radius: 8px; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="box">
        <h2>Confirm Game Login</h2>
        <p>Account: <b>${record.email}</b></p>
        <form method="POST" action="/api/auth/email-approve?token=${encodeURIComponent(token)}">
          <button type="submit">Yes, it's me</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/api/auth/email-approve', async (req, res) => {
  try {
    const token =
      (req.query && req.query.token ? String(req.query.token).trim() : '') ||
      (req.body && req.body.token ? String(req.body.token).trim() : '');

    const record = token ? emailApprovalStore.get(token) : null;
    if (!record || Date.now() > record.expiresAt) {
      if (token) emailApprovalStore.delete(token);
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;background:#111;color:#fff;text-align:center;padding:50px;">
          <h2>Link Expired or Invalid</h2>
          <p>Please return to the game and try again.</p>
        </body></html>
      `);
    }

    let user = await User.findOne({ email: record.email });
    if (!user) {
      const defaultName = record.email.split('@')[0] || 'Player';
      user = await User.create({
        name: defaultName,
        email: record.email,
        isAdultVerified: true,
        balance: 50,
        transactions: [{ type: 'credit', amount: 50, reason: 'welcome_bonus' }]
      });
    }

    record.status = 'approved';
    record.userId = user._id.toString();
    emailApprovalStore.set(token, record);

    return res.send(`
      <html><body style="font-family:sans-serif;background:#111;color:#fff;text-align:center;padding:50px;">
        <h2 style="color:#4caf50;">Login Approved!</h2>
        <p>You can now return to the game. You will be logged in automatically.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('[email-approve POST error]:', err);
    return res.status(500).send('Server error while approving login.');
  }
});

// 3C. Poll Email Approval Status from Game
app.get('/api/auth/email-status', async (req, res) => {
  try {
    const token = req.query && req.query.token ? String(req.query.token).trim() : '';
    if (!token) {
      return res.status(400).json({ success: false, message: 'Token required' });
    }

    const record = emailApprovalStore.get(token);
    if (!record) {
      return res.json({ success: false, message: 'Token not found or expired' });
    }

    if (Date.now() > record.expiresAt) {
      emailApprovalStore.delete(token);
      return res.json({ success: false, message: 'Approval link expired' });
    }

    if (record.status !== 'approved' || !record.userId) {
      return res.json({ success: false, message: 'Waiting for approval...' });
    }

    const user = await User.findById(record.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    emailApprovalStore.delete(token);

    return res.json({
      success: true,
      message: 'Email login approved',
      user: formatUserResponse(user)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Get Wallet Balance
app.get('/api/wallet/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('phone name balance transactions');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({
      success: true,
      balance: user.balance,
      transactions: user.transactions.slice(-20)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. Adjust Balance (credit / debit)
app.post('/api/wallet/adjust', async (req, res) => {
  try {
    const { userId, type, amount, reason } = req.body;
    const numericAmount = Number(amount);

    if (!userId || !['credit', 'debit'].includes(type) || !numericAmount || numericAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid request fields' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (type === 'debit' && user.balance < numericAmount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    user.balance = type === 'credit' ? user.balance + numericAmount : user.balance - numericAmount;
    user.transactions.push({
      type,
      amount: numericAmount,
      reason: reason || 'game_action'
    });

    await user.save();

    res.json({
      success: true,
      balance: user.balance
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6. Send live chat message + AI support reply
app.post('/api/chat/send', async (req, res) => {
  try {
    const roomId = String((req.body && req.body.roomId) || 'support_default').trim();
    const senderName = String((req.body && req.body.senderName) || 'Player').trim().slice(0, 24);
    const message = String((req.body && req.body.message) || '').trim().slice(0, 250);

    if (!message) {
      return res.status(400).json({ success: false, message: 'Message cannot be empty' });
    }

    const msgObj = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      roomId,
      senderName,
      message,
      createdAt: Date.now()
    };

    const list = chatRoomsStore.get(roomId) || [];
    list.push(msgObj);
    if (list.length > 50) list.shift();

    const replyText = await getSupportAutoReply(message);
    if (replyText) {
      list.push({
        id: `${Date.now()}_bot_${Math.random().toString(36).slice(2, 6)}`,
        roomId,
        senderName: 'Hira (Support)',
        message: replyText,
        createdAt: Date.now() + 10
      });
      if (list.length > 50) list.shift();
    }

    chatRoomsStore.set(roomId, list);

    return res.json({ success: true, chat: msgObj });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 7. Fetch live chat messages for a room
app.get('/api/chat/:roomId', (req, res) => {
  try {
    const roomId = String(req.params.roomId || 'support_default').trim();
    const list = chatRoomsStore.get(roomId) || [];
    return res.json({ success: true, messages: list });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
