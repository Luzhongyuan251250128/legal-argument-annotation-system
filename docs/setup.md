# 本地启动与环境配置

本文档说明如何从零启动「论证标注工作台」（`server/` + `frontend/`）。

## 一、环境要求

| 依赖 | 版本 | 检查命令 |
| --- | --- | --- |
| Node.js | 18+ | `node -v` |
| npm | 8+ | `npm -v` |
| MySQL | 8.0+（5.7 亦可） | `mysql --version` |

Node.js 未安装时，访问 <https://nodejs.org> 下载 LTS 版本。

## 二、初始化数据库

`database/schema.sql` 为一次性初始化脚本，包含：全部表结构 + 标签体系（SF / GF / SM / GM 及二级标签）+ **唯一管理员账号**。
它不含任何演示数据（任务、标注、裁定、导出、教学练习、审计日志均为空表）。

```bash
mysql -u root -p < database/schema.sql
```

验证：

```bash
mysql -u root -p argument_annotator -e "SELECT username, display_name FROM users;"
```

应返回 1 行 `admin`。

初始账号：`admin`，初始密码 `123456`（由 `schema.sql` 顶部的 `@hash_pwd` 决定）。
登录后请立即通过「个人信息 → 修改密码」改为强密码；如需在初始化前更换，先生成新哈希替换该变量：

```bash
node -e "console.log(require('bcryptjs').hashSync('你的强密码', 10))"
```

需要清空重来时执行（**会删除库内全部数据**）：

```bash
mysql -u root -p < database/reset.sql
```

## 三、配置后端

```bash
cd server
cp .env.example .env
```

编辑 `server/.env`：

```ini
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的MySQL密码
DB_NAME=argument_annotator
JWT_SECRET=change-me-to-a-random-string
JWT_EXPIRES=7d
CORS_ORIGIN=*
```

通常只需修改 `DB_PASSWORD`。`server/.env` 已被 `.gitignore` 忽略，切勿提交真实配置。

## 四、安装依赖并启动

```bash
cd server
npm install
npm start
```

启动成功后输出：

```text
论证标注工作台后端已启动: http://localhost:3000
```

健康检查：

```bash
curl http://localhost:3000/health
```

返回 `{"code":0,"message":"ok",...}` 即正常。开发时可用 `npm run dev` 开启文件监听热重启。

## 五、打开页面

浏览器访问 <http://localhost:3000/>。前端由后端静态托管（`server/app.js` 指向上一级的 `frontend/`），无需单独启动。

## 六、目录结构

```text
.
├─ database/
│  ├─ schema.sql              # 表结构 + 标签体系 + 初始管理员
│  └─ reset.sql               # 删库重置
├─ frontend/
│  └─ index.html              # 单文件前端（Vue 3 + axios，CDN 引入）
├─ server/
│  ├─ app.js                  # Express 入口与路由挂载
│  ├─ db.js                   # mysql2 连接池
│  ├─ middleware/auth.js      # JWT 签发与校验
│  ├─ routes/                 # auth / users / labels / tasks / annotations /
│  │                          # adjudications / documents / exports / teaching / admin
│  ├─ utils/                  # 统一响应、裁判理由抽取、最终版本合并
│  ├─ exports/                # 导出产物目录（运行时生成，已忽略）
│  └─ .env.example            # 环境变量模板
├─ docs/                      # 需求、参考资料、部署文档
└─ prototype/                 # 界面原型（静态，不参与运行）
```

## 七、常见问题

- **端口被占用**：修改 `.env` 中的 `PORT`。
- **上传文书解析失败**：支持 `.pdf` / `.docx` / `.txt`，旧版 `.doc` 需另存为 `.docx`；单文件上限 20MB。
- **导出的文件找不到**：导出结果写入 `server/exports/`，通过 `/exports/<文件名>` 下载。
