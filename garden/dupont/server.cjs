// Saved board definitions for the Dupont clip page. One JSON file per board
// under its own data directory (never farm.db), so a board saved on one
// computer is there on every other.
//
//   <dataDir>/<id>.json   { id, name, updated_at, board }
//
// The page owns the board shape (lib/clipgen.js normalizeBoard); the server
// only checks size and that it is an object with a name.

const fs = require('fs');
const path = require('path');
const express = require('express');

const MAX_BOARDS = 200;
const MAX_BYTES = 64 * 1024;
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

module.exports = function dupontBoards(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const router = express.Router();
  router.use(express.json({ limit: MAX_BYTES }));

  const file = (id) => path.join(dataDir, `${id}.json`);
  const read = (id) => JSON.parse(fs.readFileSync(file(id), 'utf8'));
  const ids = () => fs.readdirSync(dataDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((id) => ID_RE.test(id));

  router.get('/boards', (_req, res) => {
    const list = [];
    for (const id of ids()) {
      try {
        const { name, updated_at: updatedAt } = read(id);
        list.push({ id, name, updated_at: updatedAt });
      } catch { /* skip a damaged file rather than fail the list */ }
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    res.json(list);
  });

  router.get('/boards/:id', (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id) || !fs.existsSync(file(id))) return res.status(404).json({ error: 'Board not found' });
    res.json(read(id));
  });

  router.put('/boards/:id', (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'Board id must be lowercase letters, digits and hyphens' });
    const board = req.body?.board;
    if (!board || typeof board !== 'object' || Array.isArray(board)) return res.status(400).json({ error: 'board is required' });
    const name = typeof board.name === 'string' ? board.name.trim().slice(0, 100) : '';
    if (!name) return res.status(400).json({ error: 'board.name is required' });
    const exists = fs.existsSync(file(id));
    if (!exists && ids().length >= MAX_BOARDS) return res.status(409).json({ error: `At most ${MAX_BOARDS} saved boards` });
    const doc = { id, name, updated_at: Date.now(), board: { ...board, name } };
    fs.writeFileSync(file(id) + '.tmp', JSON.stringify(doc, null, 2));
    fs.renameSync(file(id) + '.tmp', file(id));
    res.status(exists ? 200 : 201).json(doc);
  });

  router.delete('/boards/:id', (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id) || !fs.existsSync(file(id))) return res.status(404).json({ error: 'Board not found' });
    fs.rmSync(file(id));
    res.status(204).end();
  });

  return router;
};
