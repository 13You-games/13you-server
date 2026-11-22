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
      return res.status(400).
