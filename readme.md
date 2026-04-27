# ⚡ Express Server CLI

[![npm version](https://img.shields.io/npm/v/exp-node-server.svg)](https://www.npmjs.com/package/exp-node-server)
[![npm downloads](https://img.shields.io/npm/dw/exp-node-server.svg)](https://www.npmjs.com/package/exp-node-server)
[![npm total downloads](https://img.shields.io/npm/dt/exp-node-server.svg)](https://www.npmjs.com/package/exp-node-server)
[![Made with TypeScript](https://img.shields.io/badge/Made%20with-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

---

## 🚀 Overview

A powerful `Express + TypeScript CLI` that instantly generates scalable `backend` modules with `Mongoose `/ `Prisma`, `Zod` `validation`, and `Swagger` documentation.

This tool helps developers quickly scaffold `clean`, `modular` `Express` APIs with minimal setup.

## ✨ Features

- ⚡ Generate complete `Express` + `TypeScript` modules
- 🧩 Built-in `Mongoose` / `Prisma` support
- 📘 Adds Swagger documentation automatically
- 📘 Automatic `Swagger` documentation
- 🔐 `Zod` validation ready
- 🏗️ `Modular` clean architecture
- 🚀 One command project setup
- 🔄 Add modules anytime
- 📦 Zero boilerplate setup

## 📦 Quick Start

Run directly using npx (recommended):

```Bash
npx exp-node-server -c my-api
```

This will:

- Create an Express starter project
- Install dependencies
- Prepare the project for development

## 🧩 Generate a Module

Inside your project run:

```bash
npx express-server-cli -g <module-name>
```

Example: `npx express-server-cli -g order`

Output:

```Bash
✔ order.interface.ts created
✔ order.schema.ts created
✔ order.validation.ts created
✔ order.route.ts created
✔ order.controller.ts created
✔ order.service.ts created
✔ order.swagger.ts created

🔗 Route registered in routes.ts
📘 Swagger docs registered

```

## 📁 Generated Module Structure

Each module follows a clean structure:

```Bash
src/app/modules/<module-name>/
 ├── <module>.interface.ts
 ├── <module>.schema.ts
 ├── <module>.validation.ts
 ├── <module>.route.ts
 ├── <module>.controller.ts
 ├── <module>.service.ts
 └── <module>.swagger.ts
```

## ⚙️ Run the Project

```bash
npm run dev
```

Swagger docs available at:

```bash
http://localhost:5000/docs
```

## 🧠 Tech Stack

- Express.js — Backend framework
- TypeScript — Strongly typed JavaScript
- Mongoose — MongoDB ODM
- Prisma — PostgreSQL ORM
- Zod — Runtime schema validation
- JWT — Authentication
- Swagger — API documentation

## 👨‍💻 Author

### Abumahid

GitHub
https://github.com/dev-abumahid

npm
https://www.npmjs.com/~dev_abumahid

Portfolio
https://abumahid.me

LinkedIn
https://linkedin.com/in/md-abu-mahid-islam

## ⭐ Support

If you find this project helpful, consider giving it a ⭐ on `GitHub`.

It helps the project grow and reach more developers.
