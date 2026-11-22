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

// Email transporter setup (Gmail SMTP with IPv4 & STARTTLS port 587)
let mailTransporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    family: 4,
    auth: {
      user: process.env.EMAIL_USER.trim(),
      pass: process.env.EMAIL_PASS.replace(/\s+/g, '')
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
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

const otpStore = new Map();
// token -> { email, status: 'pending' | 'approved', expiresAt, userId }
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

// 1. Send OTP for Sign-Up
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

    console.log(`[OTP for ${cleanPhone}]: ${otp}`);  res.json({ success: true, message: 'OTP sent successfully', devOtp: otp }); } catch (err) { res.status(500).json({ success: false, message: err.message }); } });  // 2. Sign-Up with Name + DOB (18+) + Phone + Password + Optional Gmail + OTP app.post('/api/auth/signup', async (req, res) => { try { const { name, dob, phone, password, email, otp } = req.body;  if (!name \vert{}\vert{} !name.trim() \vert{}\vert{} !dob \vert{}\vert{} !phone \vert{}\vert{} !password \vert{}\vert{} !otp) { return res.status(400).json({ success: false, message: 'Name, DOB, phone, password and OTP are required' }); }  const parsedDob = parseDob(dob); if (!parsedDob) { return res.status(400).json({ success: false, message: 'Invalid DOB format. Use DD/MM/YYYY' }); }  const age = calculateAge(parsedDob); if (age < 18) { return res.status(400).json({ success: false, message: '18+ age required to sign up' }); }  const cleanPhone = phone.trim(); const record = otpStore.get(cleanPhone);  if (!record \vert{}\vert{} Date.now() > record.expiresAt) { return res.status(400).json({ success: false, message: 'OTP expired. Click Get OTP again.' }); }  if (record.otp !== otp.toString().trim()) { return res.status(400).json({ success: false, message: 'Invalid OTP' }); }  const existing = await User.findOne({ phone: cleanPhone }); if (existing) { return res.status(400).json({ success: false, message: 'Account already exists' }); }  otpStore.delete(cleanPhone);  const user = await User.create({ name: name.trim(), dob: parsedDob, isAdultVerified: true, phone: cleanPhone, passwordHash: hashPassword(password), email: email ? email.trim().toLowerCase() : '', balance: 50, transactions: [{ type: 'credit', amount: 50, reason: 'welcome_bonus' }] });  res.json({ success: true, message: 'Sign up successful', user: formatUserResponse(user) }); } catch (err) { res.status(500).json({ success: false, message: err.message }); } });  // 3. Login with Phone + Password app.post('/api/auth/login', async (req, res) => { try { const { phone, password } = req.body; if (!phone \vert{}\vert{} !password) { return res.status(400).json({ success: false, message: 'Phone and password are required' }); }  const cleanPhone = phone.trim(); const user = await User.findOne({ phone: cleanPhone });  if (!user) { return res.status(404).json({ success: false, message: 'User not found. Please Sign Up.' }); }  if (!user.passwordHash \vert{}\vert{} user.passwordHash !== hashPassword(password)) { return res.status(401).json({ success: false, message: 'Wrong password' }); }  res.json({ success: true, message: 'Login successful', user: formatUserResponse(user) }); } catch (err) { res.status(500).json({ success: false, message: err.message }); } });  // 3A. Request Email Approval Link ("Yes, it's me") app.post('/api/auth/email-request', async (req, res) => { try { const rawEmail = req.body && req.body.email ? String(req.body.email).trim().toLowerCase() : ''; if (!rawEmail \vert{}\vert{} !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) { return res.status(400).json({ success: false, message: 'Valid email address required' }); }  const token = crypto.randomBytes(24).toString('hex'); const expiresAt = Date.now() + 10 * 60 * 1000; const approveUrl = `${getBaseServerUrl(req)}/api/auth/email-approve?token=${token}`;  emailApprovalStore.set(token, { email: rawEmail, status: 'pending', expiresAt, userId: null });  const appName = process.env.APP_NAME \vert{}\vert{} '13 You Games';  if (mailTransporter) { await mailTransporter.sendMail({ from: `"${appName}" <${process.env.EMAIL_USER.trim()}>`, to: rawEmail, subject: `${appName} - Confirm your login`,
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
      console.log(`[Email Approval Link for ${rawEmail}]:${approveUrl}`);
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
      <html><body style="font-family:sans-serif;background
