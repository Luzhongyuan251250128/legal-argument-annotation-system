const express = require('express');
const pool = require('../db');
const { ok, fail } = require('../utils/response');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// 拉取练习列表
router.get('/practice', authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, title, description, source_text, standard_annotation_json, published_by, published_at FROM teaching_practices ORDER BY published_at DESC'
    );
    ok(res, {
      items: rows.map(r => ({
        id: r.id,
        title: r.title,
        description: r.description,
        sourceText: r.source_text,
        standard: (function () {
          try { return typeof r.standard_annotation_json === 'string' ? JSON.parse(r.standard_annotation_json) : r.standard_annotation_json; } catch { return null; }
        })(),
        publishedBy: r.published_by,
        publishedAt: r.published_at
      }))
    });
  } catch (e) {
    fail(res, '查询失败：' + e.message);
  }
});

// 发布练习
router.post('/practice', authRequired, async (req, res) => {
  const { title, description, sourceText, standard } = req.body || {};
  if (!title) return fail(res, '缺少标题');
  try {
    const [r] = await pool.query(
      'INSERT INTO teaching_practices (title, description, source_text, standard_annotation_json, published_by) VALUES (?, ?, ?, ?, ?)',
      [title, description || null, sourceText || null, JSON.stringify(standard || {}), req.user.id]
    );
    ok(res, { id: r.insertId });
  } catch (e) {
    fail(res, '发布失败：' + e.message);
  }
});

module.exports = router;