require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');

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

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

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

async function sendApprovalEmailViaBrevo({ toEmail, approveUrl, appName }) {
  const apiKey = (process.env.BREVO_API_KEY || '').trim();
  const senderEmail = (process.env.SENDER_EMAIL || process.env.EMAIL_USER || '').trim();
  const senderName = (process.env.SENDER_NAME || appName || '13 You Games').trim();

  if (!apiKey || !senderEmail) {
    throw new Error('BREVO_API_KEY or SENDER_EMAIL/EMAIL_USER is missing in environment variables');
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      sender: {
        name: senderName,
        email: senderEmail
      },
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

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Brevo API error (${response.status}): ${errText}`);
  }
}

const otpStore = new Map();
const emailApprovalStore = new Map();

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

app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || phone.trim().length < 10) {
      return res.status(400).json({ success: false, message: 'Valid phone number required' });
    }

    const cleanPhone = phone.trim();
    const existing = await User.findOne({ phone: cleanPhone });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Number already registered. Please Login.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(cleanPhone, { otp, expiresAt: Date.now() + 5 * 60 * 1000 });

    console.log(`[OTP for ${cleanPhone}]: ${otp}`);

    res.json({
      success: true,
      message: 'OTP sent successfully',
      devOtp: otp
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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

    const cleanPhone = phone.trim();
    const record = otpStore.get(cleanPhone);

    if (!record || Date.now() > record.expiresAt) {
      return res.status(400).json({ success: false, message: 'OTP expired. Click Get OTP again.' });
    }

    if (record.otp !== otp.toString().trim()) {
      return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }

    const existing = await User.findOne({ phone: cleanPhone });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Account already exists' });
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

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'Phone and password are required' });
    }

    const cleanPhone = phone.trim();
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
    await sendApprovalEmailViaBrevo({
      toEmail: rawEmail,
      approveUrl,
      appName
    });

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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
