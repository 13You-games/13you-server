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

const otpStore = new Map();

const transactionSchema = new mongoose.Schema({
  type: { type: String, enum: ['credit', 'debit'], required: true },
  amount: { type: Number, required: true },
  reason: { type: String, default: 'game' },
  createdAt: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema(
  {
    firebaseUid: { type: String, unique: true, sparse: true },
    phone: { type: String, required: true, unique: true },
    passwordHash: { type: String },
    email: { type: String, default: '' },
    name: { type: String, required: true },
    dob: { type: Date, required: true },
    isAdultVerified: { type: Boolean, default: false },
    balance: { type: Number, default: 1000, min: 0 },
    transactions: [transactionSchema]
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);

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
      balance: 1000,
      transactions: [{ type: 'credit', amount: 50, reason: 'welcome_bonus' }]
    });

    res.json({
      success: true,
      message: 'Sign up successful',
      user: {
        id: user._id,
        name: user.name,
        dob: user.dob,
        isAdultVerified: user.isAdultVerified,
        phone: user.phone,
        email: user.email,
        balance: user.balance
      }
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
      user: {
        id: user._id,
        name: user.name,
        dob: user.dob,
        isAdultVerified: user.isAdultVerified,
        phone: user.phone,
        email: user.email,
        balance: user.balance
      }
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});