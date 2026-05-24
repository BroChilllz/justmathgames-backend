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

// Friend request: from -> to, status: pending | accepted | declined
const friendRequestSchema = new mongoose.Schema({
  from:      { type: String, required: true }, // username
  to:        { type: String, required: true }, // username
  status:    { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});
friendRequestSchema.index({ from: 1, to: 1 }, { unique: true });

// DM message between two users
const dmMessageSchema = new mongoose.Schema({
  conversationId: { type: String, required: true, index: true }, // sorted "userA:userB"
  from:      { type: String, required: true },
  text:      { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

// Group chat
const groupSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  owner:     { type: String, required: true }, // username
  members:   { type: [String], default: [] },  // usernames
  createdAt: { type: Date, default: Date.now }
});

// Group message
const groupMessageSchema = new mongoose.Schema({
  groupId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  from:      { type: String, required: true },
  text:      { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const User         = mongoose.model('User', userSchema);
const Message      = mongoose.model('Message', messageSchema);
const FriendRequest = mongoose.model('FriendRequest', friendRequestSchema);
const DmMessage    = mongoose.model('DmMessage', dmMessageSchema);
const Group        = mongoose.model('Group', groupSchema);
const GroupMessage = mongoose.model('GroupMessage', groupMessageSchema);

// ================================================================
// HELPERS
// ================================================================

function dmConversationId(a, b) {
  return [a, b].sort().join(':');
}

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

app.get('/auth/check/:username', async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  res.json({ available: !user });
});

// ================================================================
// USER DATA ROUTES
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
// GLOBAL CHAT ROUTES
// ================================================================

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

app.post('/chat', authMiddleware, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim())
    return res.status(400).json({ error: 'Message cannot be empty' });
  if (text.length > 500)
    return res.status(400).json({ error: 'Message too long (max 500 chars)' });
  try {
    const message = await Message.create({ username: req.user.username, text: text.trim() });
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// ================================================================
// FRIEND ROUTES
// ================================================================

// Send a friend request
app.post('/friends/request', authMiddleware, async (req, res) => {
  const { to } = req.body;
  const from = req.user.username;
  if (!to) return res.status(400).json({ error: 'to is required' });
  if (to === from) return res.status(400).json({ error: 'Cannot add yourself' });
  try {
    const target = await User.findOne({ username: to });
    if (!target) return res.status(404).json({ error: 'User not found' });

    // Check if already friends or request already exists
    const existing = await FriendRequest.findOne({
      $or: [{ from, to }, { from: to, to: from }]
    });
    if (existing) {
      if (existing.status === 'accepted') return res.status(400).json({ error: 'Already friends' });
      if (existing.status === 'pending')  return res.status(400).json({ error: 'Request already sent' });
      if (existing.status === 'declined') {
        // Allow re-sending after decline
        existing.status = 'pending';
        existing.from = from;
        existing.to = to;
        await existing.save();
        return res.json({ ok: true });
      }
    }
    await FriendRequest.create({ from, to });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Respond to a friend request (accept/decline)
app.post('/friends/respond', authMiddleware, async (req, res) => {
  const { from, action } = req.body; // action: 'accept' | 'decline'
  const to = req.user.username;
  if (!from || !['accept', 'decline'].includes(action))
    return res.status(400).json({ error: 'from and action (accept|decline) required' });
  try {
    const request = await FriendRequest.findOne({ from, to, status: 'pending' });
    if (!request) return res.status(404).json({ error: 'Request not found' });
    request.status = action === 'accept' ? 'accepted' : 'declined';
    await request.save();
    res.json({ ok: true, status: request.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a friend (or cancel a request)
app.delete('/friends/:username', authMiddleware, async (req, res) => {
  const me = req.user.username;
  const other = req.params.username;
  try {
    await FriendRequest.deleteOne({
      $or: [{ from: me, to: other }, { from: other, to: me }]
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all friend data: friends list, incoming requests, outgoing requests
app.get('/friends', authMiddleware, async (req, res) => {
  const me = req.user.username;
  try {
    const all = await FriendRequest.find({
      $or: [{ from: me }, { to: me }]
    }).lean();

    const friends  = [];
    const incoming = [];
    const outgoing = [];

    for (const r of all) {
      if (r.status === 'accepted') {
        friends.push(r.from === me ? r.to : r.from);
      } else if (r.status === 'pending') {
        if (r.to === me)   incoming.push(r.from);
        if (r.from === me) outgoing.push(r.to);
      }
    }

    res.json({ friends, incoming, outgoing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// DM ROUTES
// ================================================================

// Get DM conversation with another user (must be friends)
app.get('/dm/:username', authMiddleware, async (req, res) => {
  const me = req.user.username;
  const other = req.params.username;
  try {
    // Verify friendship
    const friendship = await FriendRequest.findOne({
      $or: [{ from: me, to: other }, { from: other, to: me }],
      status: 'accepted'
    });
    if (!friendship) return res.status(403).json({ error: 'You must be friends to DM' });

    const convId = dmConversationId(me, other);
    const messages = await DmMessage.find({ conversationId: convId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(messages.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send a DM (must be friends)
app.post('/dm/:username', authMiddleware, async (req, res) => {
  const me = req.user.username;
  const other = req.params.username;
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
  if (text.length > 500) return res.status(400).json({ error: 'Message too long (max 500 chars)' });
  try {
    const friendship = await FriendRequest.findOne({
      $or: [{ from: me, to: other }, { from: other, to: me }],
      status: 'accepted'
    });
    if (!friendship) return res.status(403).json({ error: 'You must be friends to DM' });

    const convId = dmConversationId(me, other);
    const message = await DmMessage.create({ conversationId: convId, from: me, text: text.trim() });
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete own DM
app.delete('/dm/message/:id', authMiddleware, async (req, res) => {
  try {
    const msg = await DmMessage.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.from !== req.user.username) return res.status(403).json({ error: 'Not your message' });
    await msg.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// GROUP CHAT ROUTES
// ================================================================

// Create a group
app.post('/groups', authMiddleware, async (req, res) => {
  const { name, members } = req.body; // members: array of usernames to invite
  const me = req.user.username;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Group name required' });
  if (name.length > 40) return res.status(400).json({ error: 'Name too long (max 40 chars)' });
  try {
    // Validate all invited members exist
    const inviteList = Array.isArray(members) ? members.filter(m => m !== me) : [];
    if (inviteList.length > 0) {
      const found = await User.find({ username: { $in: inviteList } }).lean();
      if (found.length !== inviteList.length) return res.status(400).json({ error: 'One or more users not found' });
    }
    const group = await Group.create({
      name: name.trim(),
      owner: me,
      members: [me, ...inviteList]
    });
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all groups the user is a member of
app.get('/groups', authMiddleware, async (req, res) => {
  const me = req.user.username;
  try {
    const groups = await Group.find({ members: me }).lean();
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a single group's info
app.get('/groups/:id', authMiddleware, async (req, res) => {
  const me = req.user.username;
  try {
    const group = await Group.findById(req.params.id).lean();
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.members.includes(me)) return res.status(403).json({ error: 'Not a member' });
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a member to a group (owner only)
app.post('/groups/:id/members', authMiddleware, async (req, res) => {
  const me = req.user.username;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.owner !== me) return res.status(403).json({ error: 'Only the owner can add members' });
    if (group.members.includes(username)) return res.status(400).json({ error: 'Already a member' });
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'User not found' });
    group.members.push(username);
    await group.save();
    res.json({ ok: true, members: group.members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a member (owner removes anyone, member removes self = leave)
app.delete('/groups/:id/members/:username', authMiddleware, async (req, res) => {
  const me = req.user.username;
  const target = req.params.username;
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (target !== me && group.owner !== me)
      return res.status(403).json({ error: 'Only the owner can remove others' });
    if (!group.members.includes(target)) return res.status(400).json({ error: 'Not a member' });

    // If owner is leaving, transfer ownership or delete
    if (target === group.owner) {
      const remaining = group.members.filter(m => m !== target);
      if (remaining.length === 0) {
        await group.deleteOne();
        await GroupMessage.deleteMany({ groupId: group._id });
        return res.json({ ok: true, deleted: true });
      }
      group.owner = remaining[0];
      group.members = remaining;
    } else {
      group.members = group.members.filter(m => m !== target);
    }
    await group.save();
    res.json({ ok: true, members: group.members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a group (owner only)
app.delete('/groups/:id', authMiddleware, async (req, res) => {
  const me = req.user.username;
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.owner !== me) return res.status(403).json({ error: 'Only the owner can delete the group' });
    await group.deleteOne();
    await GroupMessage.deleteMany({ groupId: group._id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get messages for a group
app.get('/groups/:id/messages', authMiddleware, async (req, res) => {
  const me = req.user.username;
  try {
    const group = await Group.findById(req.params.id).lean();
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.members.includes(me)) return res.status(403).json({ error: 'Not a member' });
    const messages = await GroupMessage.find({ groupId: req.params.id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(messages.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Post a message to a group
app.post('/groups/:id/messages', authMiddleware, async (req, res) => {
  const me = req.user.username;
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
  if (text.length > 500) return res.status(400).json({ error: 'Message too long' });
  try {
    const group = await Group.findById(req.params.id).lean();
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.members.includes(me)) return res.status(403).json({ error: 'Not a member' });
    const message = await GroupMessage.create({ groupId: req.params.id, from: me, text: text.trim() });
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete own group message
app.delete('/groups/:id/messages/:msgId', authMiddleware, async (req, res) => {
  const me = req.user.username;
  try {
    const group = await Group.findById(req.params.id).lean();
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const msg = await GroupMessage.findById(req.params.msgId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.from !== me && group.owner !== me) return res.status(403).json({ error: 'Not your message' });
    await msg.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================

app.get('/', (req, res) => res.send('JustMathGames API running'));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
