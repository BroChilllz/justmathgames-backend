const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'changethis';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

// ================================================================
// SCHEMAS
// ================================================================

const userSchema = new mongoose.Schema({
  userId:    { type: String, required: true, unique: true, index: true },
  username:  { type: String, unique: true, sparse: true },
  password:  { type: String },
  favorites: { type: [String], default: [] },
  settings:  { type: Object, default: {} },
  gameSaves: { type: Object, default: {} },
  idbSaves:  { type: Object, default: {} },
  updatedAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  username:  { type: String, required: true },
  text:      { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// ================================================================
// AUTH MIDDLEWARE
// ================================================================

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ================================================================
// AUTH ROUTES
// ================================================================

// Register
app.post('/auth/register', async (req, res) => {
  const { username, password, userId } = req.body;
  if (!username || !password || !userId)
    return res.status(400).json({ error: 'username, password, and userId required' });
  if (username.length < 3 || username.length > 20)
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(username))
    return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: 'Username already taken' });
    const hashed = await bcrypt.hash(password, 10);
    await User.findOneAndUpdate(
      { userId },
      { username, password: hashed },
      { upsert: true, new: true }
    );
    const token = jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });
  try {
    const user = await User.findOne({ username });
    if (!user || !user.password)
      return res.status(400).json({ error: 'Invalid username or password' });
    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(400).json({ error: 'Invalid username or password' });
    const token = jwt.sign({ userId: user.userId, username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, username, userId: user.userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check if username is taken (for live validation)
app.get('/auth/check/:username', async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  res.json({ available: !user });
});

// ================================================================
// USER DATA ROUTES (unchanged from before)
// ================================================================

app.get('/user/:id', async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.id });
    if (!user) return res.json({ favorites: [], settings: {}, gameSaves: {}, idbSaves: {} });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/user/:id', async (req, res) => {
  try {
    const existing = await User.findOne({ userId: req.params.id });
    const update = { updatedAt: new Date() };
    if (req.body.favorites !== undefined) update.favorites = req.body.favorites;
    if (req.body.settings  !== undefined) update.settings  = req.body.settings;
    if (req.body.gameSaves) {
      update.gameSaves = { ...(existing?.gameSaves || {}), ...req.body.gameSaves };
    }
    if (req.body.idbSaves) {
      const existingIdb = existing?.idbSaves || {};
      const merged = { ...existingIdb };
      for (const [dbName, stores] of Object.entries(req.body.idbSaves)) {
        merged[dbName] = { ...(existingIdb[dbName] || {}), ...stores };
      }
      update.idbSaves = merged;
    }
    await User.findOneAndUpdate(
      { userId: req.params.id },
      { $set: update },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/user/:id/save/:game', async (req, res) => {
  try {
    await User.findOneAndUpdate(
      { userId: req.params.id },
      { $unset: { [`gameSaves.${req.params.game}`]: '' } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// CHAT ROUTES
// ================================================================

// Get last 50 messages
app.get('/chat', async (req, res) => {
  try {
    const messages = await Message.find()
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json(messages.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Post a message (requires login)
app.post('/chat', authMiddleware, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim())
    return res.status(400).json({ error: 'Message cannot be empty' });
  if (text.length > 500)
    return res.status(400).json({ error: 'Message too long (max 500 chars)' });
  try {
    const message = await Message.create({
      username: req.user.username,
      text: text.trim()
    });
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete own message
app.delete('/chat/:id', authMiddleware, async (req, res) => {
  try {
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.username !== req.user.username)
      return res.status(403).json({ error: 'Not your message' });
    await msg.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('JustMathGames API running'));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
