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
  bio:       { type: String, default: '' },
  pfp:       { type: String, default: '' },
  presenceStatus: { type: String, enum: ['online', 'offline'], default: 'offline' },
  activity:  { type: String, default: '' },
  lastSeen:  { type: Date, default: Date.now },
  favorites: { type: [String], default: [] },
  favoriteItems: { type: [String], default: [] },
  contentVotes:  { type: Object, default: {} },
  contentStats:  { type: Object, default: {} },
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

const contentVoteSchema = new mongoose.Schema({
  userId:     { type: String, required: true, index: true },
  contentKey: { type: String, required: true, index: true },
  vote:       { type: String, enum: ['like', 'dislike'], required: true },
  updatedAt:  { type: Date, default: Date.now }
});
contentVoteSchema.index({ userId: 1, contentKey: 1 }, { unique: true });

const User         = mongoose.model('User', userSchema);
const Message      = mongoose.model('Message', messageSchema);
const FriendRequest = mongoose.model('FriendRequest', friendRequestSchema);
const DmMessage    = mongoose.model('DmMessage', dmMessageSchema);
const Group        = mongoose.model('Group', groupSchema);
const GroupMessage = mongoose.model('GroupMessage', groupMessageSchema);
const ContentVote  = mongoose.model('ContentVote', contentVoteSchema);

// ================================================================
// HELPERS
// ================================================================

function dmConversationId(a, b) {
  return [a, b].sort().join(':');
}

function isValidUsername(username) {
  return typeof username === 'string' &&
    username.length >= 3 &&
    username.length <= 20 &&
    /^[a-zA-Z0-9_]+$/.test(username);
}

function normalizeBio(value) {
  return String(value || '').trim().slice(0, 220);
}

function normalizePfp(value) {
  const pfp = String(value || '').trim();
  if (!pfp) return '';
  if (pfp.length > 500) return null;
  try {
    const parsed = new URL(pfp);
    return ['http:', 'https:'].includes(parsed.protocol) ? pfp : null;
  } catch {
    return null;
  }
}

function normalizeStringArray(value, maxItems = 500) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map(item => String(item || '').trim())
      .filter(Boolean)
      .slice(0, maxItems)
  ));
}

function normalizeContentVoteMap(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, vote] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length > 500) continue;
    if (vote === 'like' || vote === 'dislike') result[key] = vote;
  }
  return result;
}

function normalizeContentStatsMap(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, stats] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length > 500) continue;
    result[key] = {
      likes: Math.max(0, Number(stats?.likes) || 0),
      dislikes: Math.max(0, Number(stats?.dislikes) || 0)
    };
  }
  return result;
}

function publicProfile(user) {
  const lastSeenTime = user.lastSeen ? new Date(user.lastSeen).getTime() : 0;
  const online = Date.now() - lastSeenTime < 45 * 1000 && user.presenceStatus !== 'offline';
  const activity = online ? (user.activity || '') : '';
  return {
    username: user.username,
    bio: user.bio || '',
    pfp: user.pfp || '',
    avatar: user.pfp || '',
    avatarUrl: user.pfp || '',
    online,
    statusClass: activity ? 'playing' : online ? 'online' : 'offline',
    statusText: activity || (online ? 'Online' : 'Offline'),
    activity,
    lastSeen: user.lastSeen
  };
}

function userDataResponse(user) {
  return {
    userId: user?.userId || '',
    username: user?.username || '',
    bio: user?.bio || '',
    pfp: user?.pfp || '',
    online: user ? publicProfile(user).online : false,
    statusClass: user ? publicProfile(user).statusClass : 'offline',
    statusText: user ? publicProfile(user).statusText : 'Offline',
    activity: user?.activity || '',
    lastSeen: user?.lastSeen,
    favorites: user?.favorites || [],
    favoriteItems: user?.favoriteItems || [],
    contentVotes: user?.contentVotes || {},
    contentStats: user?.contentStats || {},
    settings: user?.settings || {},
    gameSaves: user?.gameSaves || {},
    idbSaves: user?.idbSaves || {},
    updatedAt: user?.updatedAt
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function cascadeUsernameChange(oldUsername, newUsername) {
  if (!oldUsername || oldUsername === newUsername) return;

  await Promise.all([
    Message.updateMany({ username: oldUsername }, { $set: { username: newUsername } }),
    FriendRequest.updateMany({ from: oldUsername }, { $set: { from: newUsername } }),
    FriendRequest.updateMany({ to: oldUsername }, { $set: { to: newUsername } }),
    Group.updateMany({ owner: oldUsername }, { $set: { owner: newUsername } }),
    Group.updateMany({ members: oldUsername }, { $set: { 'members.$': newUsername } }),
    GroupMessage.updateMany({ from: oldUsername }, { $set: { from: newUsername } })
  ]);

  const dmNamePattern = new RegExp(`(^|:)${escapeRegExp(oldUsername)}(:|$)`);
  const dmMessages = await DmMessage.find({ conversationId: dmNamePattern });
  for (const message of dmMessages) {
    const participants = message.conversationId
      .split(':')
      .map(name => name === oldUsername ? newUsername : name);
    if (participants.length === 2) {
      message.conversationId = dmConversationId(participants[0], participants[1]);
    }
    if (message.from === oldUsername) message.from = newUsername;
    await message.save();
  }
}

async function getContentStats(contentKey) {
  const match = contentKey ? { contentKey } : {};
  const rows = await ContentVote.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$contentKey',
        likes: { $sum: { $cond: [{ $eq: ['$vote', 'like'] }, 1, 0] } },
        dislikes: { $sum: { $cond: [{ $eq: ['$vote', 'dislike'] }, 1, 0] } }
      }
    }
  ]);

  const stats = {};
  for (const row of rows) {
    stats[row._id] = { likes: row.likes || 0, dislikes: row.dislikes || 0 };
  }

  if (contentKey) return stats[contentKey] || { likes: 0, dislikes: 0 };
  return stats;
}

async function getContentVotesForUser(userId) {
  const votes = await ContentVote.find({ userId }).lean();
  return votes.reduce((result, item) => {
    result[item.contentKey] = item.vote;
    return result;
  }, {});
}

// ================================================================
// AUTH MIDDLEWARE
// ================================================================

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Trust the JWT — no DB call needed just to authenticate
    if (!payload.userId || !payload.username)
      return res.status(401).json({ error: 'Invalid token' });
    req.user = { userId: payload.userId, username: payload.username };
    next();
  } catch (err) {
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
  if (!isValidUsername(username))
    return res.status(400).json({ error: 'Username must be 3-20 letters, numbers, or underscores' });
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
    res.json({ ok: true, token, username, userId, bio: '', pfp: '' });
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
  if (!isValidUsername(req.params.username))
    return res.json({ available: false });
  const user = await User.findOne({ username: req.params.username });
  res.json({ available: !user });
});

// ================================================================
// PROFILE ROUTES
// ================================================================

app.get('/profile/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: 'Profile not found' });
    res.json(publicProfile(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/profile', authMiddleware, async (req, res) => {
  const nextUsername = String(req.body.username || req.user.username).trim();
  const hasBio = Object.prototype.hasOwnProperty.call(req.body, 'bio');
  const hasPfp = Object.prototype.hasOwnProperty.call(req.body, 'pfp');
  const nextBio = hasBio ? normalizeBio(req.body.bio) : '';
  const nextPfp = hasPfp ? normalizePfp(req.body.pfp) : '';
  const nextPassword = req.body.password ? String(req.body.password) : '';

  if (!isValidUsername(nextUsername))
    return res.status(400).json({ error: 'Username must be 3-20 letters, numbers, or underscores' });
  if (hasPfp && nextPfp === null)
    return res.status(400).json({ error: 'PFP must be a valid http or https URL under 500 characters' });
  if (nextPassword && nextPassword.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const user = await User.findOne({ userId: req.user.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (nextUsername !== user.username) {
      const existing = await User.findOne({ username: nextUsername, _id: { $ne: user._id } });
      if (existing) return res.status(400).json({ error: 'Username already taken' });
      await cascadeUsernameChange(user.username, nextUsername);
      user.username = nextUsername;
    }

    if (hasBio) user.bio = nextBio;
    if (hasPfp) user.pfp = nextPfp || '';
    if (nextPassword) user.password = await bcrypt.hash(nextPassword, 10);
    user.updatedAt = new Date();
    await user.save();

    const token = jwt.sign({ userId: user.userId, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, userId: user.userId, ...publicProfile(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// PRESENCE ROUTES
// ================================================================

app.post('/presence', authMiddleware, async (req, res) => {
  const status = req.body.status === 'offline' ? 'offline' : 'online';
  const activity = status === 'online'
    ? String(req.body.activity || '').trim().slice(0, 80)
    : '';

  try {
    await User.findOneAndUpdate(
      { userId: req.user.userId },
      {
        $set: {
          presenceStatus: status,
          activity,
          lastSeen: new Date(),
          updatedAt: new Date()
        }
      }
    );
    res.json({ ok: true, status, activity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// USER DATA ROUTES
// ================================================================

app.get('/user/:id', async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.id });
    if (!user) return res.json(userDataResponse(null));
    res.json(userDataResponse(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/user/:id', async (req, res) => {
  try {
    const existing = await User.findOne({ userId: req.params.id });
    const update = { updatedAt: new Date() };
    if (req.body.favorites !== undefined) update.favorites = normalizeStringArray(req.body.favorites);
    if (req.body.favoriteItems !== undefined) update.favoriteItems = normalizeStringArray(req.body.favoriteItems);
    if (req.body.contentVotes !== undefined) update.contentVotes = normalizeContentVoteMap(req.body.contentVotes);
    if (req.body.contentStats !== undefined) update.contentStats = normalizeContentStatsMap(req.body.contentStats);
    if (req.body.bio !== undefined) update.bio = normalizeBio(req.body.bio);
    if (req.body.pfp !== undefined) {
      const pfp = normalizePfp(req.body.pfp);
      if (pfp === null) return res.status(400).json({ error: 'PFP must be a valid http or https URL under 500 characters' });
      update.pfp = pfp;
    }
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
// CONTENT FAVORITES / VOTING ROUTES
// ================================================================

app.get('/content/stats', async (req, res) => {
  try {
    res.json({ stats: await getContentStats() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/content/votes/:userId', async (req, res) => {
  try {
    res.json({ votes: await getContentVotesForUser(req.params.userId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/content/state/:userId', async (req, res) => {
  try {
    const [stats, votes] = await Promise.all([
      getContentStats(),
      getContentVotesForUser(req.params.userId)
    ]);
    res.json({ stats, votes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/social/summary', authMiddleware, async (req, res) => {
  const me = req.user.username;
  try {
    const [friendData, groups, globalMsgs] = await Promise.all([
      FriendRequest.find({ $or: [{ from: me }, { to: me }] }).lean(),
      Group.find({ members: me }).lean(),
      Message.find().sort({ createdAt: -1 }).limit(1).lean()
    ]);

    const friends = [];
    const incoming = [];
    const outgoing = [];
    for (const r of friendData) {
      if (r.status === 'accepted') friends.push(r.from === me ? r.to : r.from);
      else if (r.status === 'pending') {
        if (r.to === me) incoming.push(r.from);
        if (r.from === me) outgoing.push(r.to);
      }
    }

    const friendsSlice = friends.slice(0, 8);
    const groupsSlice  = groups.slice(0, 4);

    // All last-message lookups in parallel
    const [dmResults, groupMsgResults, profiles] = await Promise.all([
      Promise.all(friendsSlice.map(u =>
        DmMessage.findOne({ conversationId: dmConversationId(me, u) })
          .sort({ createdAt: -1 }).lean()
      )),
      Promise.all(groupsSlice.map(g =>
        GroupMessage.findOne({ groupId: g._id })
          .sort({ createdAt: -1 }).lean()
      )),
      User.find({ username: { $in: friendsSlice } })
        .select('username pfp presenceStatus activity lastSeen').lean()
    ]);

    const profileMap = {};
    for (const u of profiles) profileMap[u.username] = publicProfile(u);

    res.json({
      friends, incoming, outgoing,
      profiles: profileMap,
      groups: groupsSlice,
      dmLastMessages: Object.fromEntries(friendsSlice.map((u, i) => [u, dmResults[i]])),
      groupLastMessages: Object.fromEntries(groupsSlice.map((g, i) => [String(g._id), groupMsgResults[i]])),
      globalLastMessage: globalMsgs[0] || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/content/vote/:userId', async (req, res) => {
  const userId = String(req.params.userId || '').trim();
  const contentKey = String(req.body.contentKey || '').trim();
  const vote = String(req.body.vote || '').trim();

  if (!userId || userId.length > 120)
    return res.status(400).json({ error: 'Valid userId required' });
  if (!contentKey || contentKey.length > 500)
    return res.status(400).json({ error: 'Valid contentKey required' });
  if (vote && !['like', 'dislike'].includes(vote))
    return res.status(400).json({ error: 'Vote must be like, dislike, or empty' });

  try {
    if (vote) {
      await ContentVote.findOneAndUpdate(
        { userId, contentKey },
        { $set: { vote, updatedAt: new Date() } },
        { upsert: true, new: true }
      );
    } else {
      await ContentVote.deleteOne({ userId, contentKey });
    }

    const [stats, votes] = await Promise.all([
      getContentStats(contentKey),
      getContentVotesForUser(userId)
    ]);

    await User.findOneAndUpdate(
      { userId },
      {
        $set: {
          contentVotes: votes,
          updatedAt: new Date()
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ ok: true, vote, contentKey, stats, votes });
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

    const usernames = Array.from(new Set([me, ...friends, ...incoming, ...outgoing]));
    const users = await User.find({ username: { $in: usernames } }).lean();
    const profiles = {};
    for (const user of users) {
      profiles[user.username] = publicProfile(user);
    }

    res.json({ friends, incoming, outgoing, profiles });
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

const { AccessToken } = require('livekit-server-sdk');

// Generate a token to join a VC room
app.post('/vc/token', authMiddleware, async (req, res) => {
  const { room } = req.body;
  if (!room || typeof room !== 'string' || room.length > 100)
    return res.status(400).json({ error: 'Valid room name required' });

  try {
    const token = new AccessToken(
      process.env.LK_API_KEY,
      process.env.LK_API_SECRET,
      { identity: req.user.username, ttl: '4h' }
    );
    token.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishSources: ['microphone', 'screen_share', 'screen_share_audio']
    });
    res.json({ token: await token.toJwt(), url: process.env.LK_URL });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================

app.get('/', (req, res) => res.send('JustMathGames API running'));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
