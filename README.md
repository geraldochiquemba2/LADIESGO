<div align="center">

![ TaxiApp Banner](.github/images/banner.svg)

<br/>

[![NestJS](https://img.shields.io/badge/NestJS-E0234E?style=for-the-badge&logo=nestjs&logoColor=white)](https://nestjs.com)
[![React Native](https://img.shields.io/badge/React_Native-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://reactnative.dev)
[![Expo](https://img.shields.io/badge/Expo-000020?style=for-the-badge&logo=expo&logoColor=white)](https://expo.dev)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-336791?style=for-the-badge&logo=postgresql&logoColor=white)](https://postgresql.org)
[![Socket.io](https://img.shields.io/badge/Socket.io-010101?style=for-the-badge&logo=socket.io&logoColor=white)](https://socket.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Stripe](https://img.shields.io/badge/Stripe-6772E5?style=for-the-badge&logo=stripe&logoColor=white)](https://stripe.com)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://docker.com)

<br/>

[![GitHub Stars](https://img.shields.io/github/stars/khaledq84ever/taxiapp?style=flat-square&color=FFD700)](https://github.com/khaledq84ever/taxiapp/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/khaledq84ever/taxiapp?style=flat-square&color=red)](https://github.com/khaledq84ever/taxiapp/issues)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](CONTRIBUTING.md)

<br/>

**A full-stack ride-sharing platform built for Saudi Arabia — Uber/Careem style.**  
Passenger app · Driver app · Admin dashboard · Real-time tracking · Stripe payments

</div>

---

## 🏗️ Architecture

![ Architecture](.github/images/architecture.svg)

---

## ✨ Features

![ Features](.github/images/features.svg)

---

## 🛠️ Tech Stack

![ Tech Stack](.github/images/tech-stack.svg)

---

## 🔄 Trip Lifecycle

![ Trip Flow](.github/images/trip-flow.svg)

---

## 📡 API Reference

![ API Endpoints](.github/images/api-endpoints.svg)

---

## 📁 Project Structure

```
taxiapp/
│
├── 📁 backend/                    # NestJS API Server
│   ├── src/
│   │   ├── auth/                  # Phone login + JWT tokens
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   ├── auth.module.ts
│   │   │   ├── jwt.strategy.ts
│   │   │   └── dto/
│   │   ├── users/                 # Passenger profiles
│   │   ├── drivers/               # Driver registration + GPS
│   │   ├── trips/                 # Trip lifecycle + Socket gateway
│   │   │   ├── trips.service.ts   # Fare calc + trip CRUD
│   │   │   ├── trips.gateway.ts   # Socket.io real-time events
│   │   │   └── trips.controller.ts
│   │   ├── payments/              # Stripe integration
│   │   ├── ratings/               # Post-trip ratings
│   │   ├── admin/                 # Admin management APIs
│   │   ├── prisma/                # DB service (global)
│   │   └── common/
│   │       ├── guards/            # JWT + Roles guards
│   │       └── decorators/        # @CurrentUser, @Roles
│   ├── prisma/
│   │   └── schema.prisma          # Full DB schema (7 models)
│   ├── .env.example
│   └── package.json
│
├── 📁 mobile/                     # Expo app = casca WebView (o produto vive no webapp)
│   ├── index.ts                   # Entrada: registerRootComponent(App)
│   ├── App.tsx                    # WebView + bridge de auth/GPS/bússola/push
│   ├── assets/                    # Ícone do splash/loading
│   └── src/services/              # Só estes 4 ficheiros entram no bundle:
│       ├── api.ts                 # Axios + JWT + driversApi
│       ├── bgLocation.ts          # Task de GPS em fundo
│       ├── driverBgLocation.ts    # Task de GPS da motorista
│       └── driverGeoSocket.ts     # WS /drivers/live-geo
│                                  # (só o Metro compila o que é importado; ver mobile/AGENTS.md)
│
├── 📁 admin/                      # React.js Admin Dashboard
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx      # Stats overview
│   │   │   ├── DriversPage.tsx    # Approve/reject drivers
│   │   │   └── TripsPage.tsx      # All trips + filter
│   │   ├── components/
│   │   │   └── Sidebar.tsx        # Navigation sidebar
│   │   └── services/
│   │       └── api.ts             # Admin API calls
│   └── src/App.tsx                # Router + login page
│
├── 📄 docker-compose.yml          # PostgreSQL + Redis + Backend
├── 📄 .gitignore
└── 📄 project_roadmap.txt         # Full build plan
```

---

## 🚀 Quick Start

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) |
| npm | ≥ 9 | Included with Node |
| Docker | any | [docker.com](https://docker.com) |
| PostgreSQL | 16 | Via Docker (below) |

---

### 1. Clone the repo

```bash
git clone https://github.com/khaledq84ever/taxiapp.git
cd taxiapp
```

### 2. Start the database (Docker)

```bash
# Start PostgreSQL + Redis
docker-compose up -d postgres redis

# Check they're running
docker ps
```

### 3. Setup the backend

```bash
cd backend

# Copy env file and fill in your keys
cp .env.example .env

# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Run database migrations
npx prisma migrate dev --name init

# Start the dev server
npm run start:dev
```

> Backend runs at: `http://localhost:3000/api/v1`

> **Live Production URL:** `https://taxiapp-api-production.up.railway.app/api/v1`

### 4. Setup the mobile app

```bash
cd ../mobile

# Install dependencies
npm install

# Start Expo dev server
npx expo start

# Then press:
# a → Android emulator
# i → iOS simulator
# w → Web browser
```

### 5. Setup the admin dashboard

```bash
cd ../admin

# Install dependencies
npm install

# Start dev server
npm start
```

> Admin panel runs at: `http://localhost:3001`

---

## ⚙️ Environment Variables

Create `backend/.env` with these values:

```env
# ─── Database ─────────────────────────────────────────────
DATABASE_URL="postgresql://postgres:password@localhost:5432/taxiapp"

# ─── JWT Authentication ───────────────────────────────────
JWT_SECRET="your-super-secret-jwt-key-change-in-production"
JWT_EXPIRES_IN="7d"

# ─── Stripe (Payments) ────────────────────────────────────
STRIPE_SECRET_KEY="sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
STRIPE_WEBHOOK_SECRET="whsec_xxxxxxxx"

# ─── Firebase (Push Notifications) ───────────────────────
FIREBASE_PROJECT_ID="your-project-id"
FIREBASE_CLIENT_EMAIL="firebase-adminsdk@your-project.iam.gserviceaccount.com"
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# ─── Google Maps ──────────────────────────────────────────
GOOGLE_MAPS_API_KEY="your-google-maps-api-key"

# ─── App ──────────────────────────────────────────────────
NODE_ENV="development"
PORT=3000
```

---

## 🗄️ Database Schema

```prisma
model User {
  id           String   @id @default(cuid())
  phone        String   @unique          # E.164 format (+966...)
  role         Role                      # PASSENGER | DRIVER | ADMIN
  isVerified   Boolean  @default(false)
  # ... profile fields
}

model Driver {
  status       DriverStatus              # PENDING | APPROVED | REJECTED | SUSPENDED
  isOnline     Boolean  @default(false)
  currentLat   Float?                    # Live GPS
  currentLng   Float?
  rating       Float    @default(5.0)
  totalEarnings Float   @default(0)
}

model Trip {
  status       TripStatus                # REQUESTED → ACCEPTED → DRIVER_ARRIVED
                                         # → IN_PROGRESS → COMPLETED | CANCELLED
  fareEstimate Float
  finalFare    Float?
  distanceKm   Float?
  paymentMethod PaymentMethod            # CASH | CARD
}
```

---

## 📡 Socket.io Events

### Client → Server

```typescript
// Driver sends location every 5 seconds
socket.emit('driver:location-update', { lat: 24.7136, lng: 46.6753 })

// Passenger requests ride (after REST /trips/request)
socket.emit('passenger:trip-request', { tripId: 'clxxx...' })

// Driver accepts (after REST /trips/:id/accept)
socket.emit('driver:trip-accepted', { tripId: 'clxxx...' })

// Passenger cancels
socket.emit('passenger:cancel-trip', { tripId: 'clxxx...' })
```

### Server → Client

```typescript
// Passenger receives: driver found
socket.on('server:driver-found', (data) => {
  console.log(data.driver, data.tripId)
})

// Passenger receives: live location updates
socket.on('server:driver-location', (data) => {
  updateMapMarker(data.lat, data.lng)
})

// Driver receives: new trip request
socket.on('server:new-trip-request', (data) => {
  showTripRequestPopup(data.trip, data.passenger)
})
```

### Connect with auth

```typescript
const socket = io('http://localhost:3000/trips', {
  auth: { token: 'Bearer <your-jwt-token>' }
})
```

---

## 💰 Fare Calculation

```
Base Fare:      5 SAR
Per KM Rate:    2.5 SAR/km
Distance:       Haversine formula (great-circle distance)
Commission:     20% platform fee (driver keeps 80%)

Example:
  Distance = 8 km
  Fare     = 5 + (8 × 2.5) = 25 SAR
  Driver   = 25 × 0.80    = 20 SAR
```

---

## 🧪 Testing the API

### Login (no OTP — phone number alone identifies the account)

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"phone": "+966501234567", "role": "PASSENGER"}'
```

### Estimate a fare

```bash
curl -X POST http://localhost:3000/api/v1/trips/estimate \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "pickupLat": 24.7136, "pickupLng": 46.6753,
    "dropoffLat": 24.7741, "dropoffLng": 46.7385
  }'
```

### Get nearby drivers

```bash
curl "http://localhost:3000/api/v1/drivers/nearby?lat=24.7136&lng=46.6753" \
  -H "Authorization: Bearer <token>"
```

### Check database

```bash
npx prisma studio       # Opens visual DB browser at localhost:5555
```

---

## 🚢 Deployment

### Backend → Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway up

# Set environment variables
railway variables set JWT_SECRET=your-secret
railway variables set DATABASE_URL=your-postgres-url
```

### Admin → Vercel

```bash
# Install Vercel CLI
npm install -g vercel

cd admin
vercel --prod
```

### Mobile → App Stores

```bash
cd mobile

# Build for Android
npx expo build:android

# Build for iOS (requires Mac)
npx expo build:ios

# Or use EAS Build (cloud)
npm install -g eas-cli
eas build --platform all
```

---

## 🗺️ Roadmap

- [x] NestJS backend with all modules
- [x] Phone-based authentication (no OTP)
- [x] Real-time Socket.io driver tracking
- [x] Stripe payment integration
- [x] React Native mobile app (passenger + driver)
- [x] Admin dashboard
- [x] Prisma database schema
- [ ] Arabic RTL language support
- [ ] Mada / STC Pay integration
- [ ] Driver document verification with OCR
- [ ] Surge pricing during peak hours
- [ ] Scheduled rides (book in advance)
- [ ] Multi-stop trips
- [ ] In-app chat between passenger and driver
- [ ] CI/CD pipeline (GitHub Actions)

---

## 📄 License

MIT © [khaledq84ever](https://github.com/khaledq84ever)

---

<div align="center">
  <strong>Built with ❤️ for Saudi Arabia 🇸🇦</strong><br/>
  <sub>If this project helped you, please ⭐ star it on GitHub!</sub>
</div>
