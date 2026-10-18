-- ============================================================
-- 论证标注工作台 · 数据库重置
-- 用法：
--   mysql -u root -p < reset.sql
-- 作用：
--   删除 argument_annotator 库及其全部数据；
--   重置后可按顺序重新执行 schema.sql 和 seed.sql。
-- ============================================================

DROP DATABASE IF EXISTS argument_annotator;