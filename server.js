const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // game saves can be large

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

const userSchema = new mongoose.Schema({
  userId:    { type: String, required: true, unique: true, index: true },
  favorites: { type: [String], default: [] },
  settings:  { type: Object, default: {} },
  gameSaves: { type: Object, default: {} }, // localStorage data
  idbSaves:  { type: Object, default: {} }, // IndexedDB data
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// GET all user data
app.get('/user/:id', async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.id });
    if (!user) return res.json({ favorites: [], settings: {}, gameSaves: {}, idbSaves: {} });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST — deep merge so one game's backup never wipes another's
app.post('/user/:id', async (req, res) => {
  try {
    const existing = await User.findOne({ userId: req.params.id });
    const update = { updatedAt: new Date() };

    if (req.body.favorites !== undefined) update.favorites = req.body.favorites;
    if (req.body.settings  !== undefined) update.settings  = req.body.settings;

    // Merge localStorage saves
    if (req.body.gameSaves) {
      update.gameSaves = {
        ...(existing?.gameSaves || {}),
        ...req.body.gameSaves
      };
    }

    // Deep merge IndexedDB saves (db level, then store level)
    if (req.body.idbSaves) {
      const existingIdb = existing?.idbSaves || {};
      const incoming = req.body.idbSaves;
      const merged = { ...existingIdb };
      for (const [dbName, stores] of Object.entries(incoming)) {
        merged[dbName] = {
          ...(existingIdb[dbName] || {}),
          ...stores
        };
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

// DELETE a specific game's localStorage save
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

app.get('/', (req, res) => res.send('JustMathGames API running'));

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
