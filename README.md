# KashBook API — Setup Guide

## Stack
- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: MongoDB (via Mongoose)
- **Auth**: JWT (30-day tokens), bcrypt, Google OAuth
- **SMS**: Africa's Talking (Nigerian provider)
- **Email**: Nodemailer (SMTP)

---

## Quick Start

### 1. Install dependencies
```bash
cd server
npm install
```

### 2. Get MongoDB
**Option A — Local** (install MongoDB Community Edition):
```
mongodb://localhost:27017/kashbook
```

**Option B — MongoDB Atlas** (free cloud, no install):
1. [cloud.mongodb.com](https://cloud.mongodb.com) → free cluster
2. Connect → copy connection string → replace `<password>`

### 3. Configure environment
```bash
cp .env.example .env
# Minimum required:
#   MONGODB_URI=mongodb://localhost:27017/kashbook
#   JWT_SECRET=any-long-random-string
```

### 4. Start the server
```bash
npm run dev    # development (hot reload via nodemon)
npm start      # production
```
Server runs on **http://localhost:3000**

---

## Connect the React Native app

In `src/utils/api.js`, set `API_BASE_URL`:

| Environment      | URL |
|-----------------|-----|
| Android emulator | `http://10.0.2.2:3000` |
| iOS simulator    | `http://localhost:3000` |
| Physical device  | `http://YOUR_LAN_IP:3000` |
| Production       | `https://your-domain.com` |

---

## Deploy to Railway (free)
1. Push to GitHub → [railway.app](https://railway.app) → New Project → GitHub
2. Add MongoDB plugin OR set `MONGODB_URI` to Atlas connection string
3. Add all env vars from `.env.example`
4. Railway provides a public HTTPS URL

---

## MongoDB Collections

| Collection | Description |
|---|---|
| `users` | Accounts (email/password, phone, Google) |
| `businesses` | Businesses per user |
| `transactions` | Income & expenses |
| `customers` | Customers with embedded debts & payments |
| `inventoryitems` | Stock items |
| `payables` | What the business owes, with embedded payments |
| `otpcodes` | Verification codes (auto-deleted via TTL index) |

---

## Auth API

| Method | Path | Body |
|--------|------|------|
| POST | `/auth/register` | `{ name, email, password }` |
| POST | `/auth/login` | `{ email, password }` |
| POST | `/auth/google` | `{ idToken }` |
| POST | `/auth/send-otp` | `{ phone, type }` |
| POST | `/auth/verify-otp` | `{ phone, code, name? }` |
| POST | `/auth/forgot-password` | `{ email }` |
| POST | `/auth/reset-password` | `{ email, code, newPassword }` |

All other routes require `Authorization: Bearer <token>` header.

## Sync API
| Method | Path | Notes |
|--------|------|-------|
| POST | `/sync` | `{ queue: [...ops] }` |
| GET | `/sync/pull?businessId=` | Full data snapshot |
