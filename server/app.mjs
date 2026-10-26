import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATEGORIES = ['vegetables', 'fruit', 'bakery', 'prepared', 'dairy', 'pantry'];
const UNITS = ['kg', 'portions', 'items', 'crates', 'loaves'];
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const text = (v) => typeof v === 'string' ? v.trim() : '';
const now = () => new Date().toISOString();
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const required = (value, label, max = 200) => {
  const result = text(value);
  if (!result || result.length > max) fail(400, `${label} is required and must be at most ${max} characters.`);
  return result;
};
const optional = (value, label, max = 200) => {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.trim().length > max) fail(400, `${label} must be at most ${max} characters.`);
  return value.trim();
};
function coordinate(value, label, limit) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) fail(400, `${label} is invalid.`);
  return n;
}
function mapsUrl(value) {
  const result = optional(value, 'Google Maps link', 1000);
  if (!result) return '';
  let parsed;
  try { parsed = new URL(result); } catch { fail(400, 'Enter a valid Google Maps URL.'); }
  const host = parsed.hostname.toLowerCase();
  const short = ['maps.app.goo.gl', 'goo.gl'].includes(host);
  const google = /^(www\.|maps\.)?google\.(com|co\.uk|ro)$/.test(host);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !(short || google && (host.startsWith('maps.') || parsed.pathname.startsWith('/maps')))) {
    fail(400, 'Use a secure Google Maps profile or place link.');
  }
  return parsed.toString();
}
function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function passwordMatches(password, stored) {
  const [salt, hash] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function distanceKm(a, b, c, d) {
  if ([a, b, c, d].some(v => v == null)) return null;
  const radians = n => n * Math.PI / 180;
  const x = Math.sin(radians(c - a) / 2) ** 2 + Math.cos(radians(a)) * Math.cos(radians(c)) * Math.sin(radians(d - b) / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)) * 10) / 10;
}
function profileFields(body, old = {}) {
  const merged = { ...old, ...body };
  const latitude = coordinate(merged.latitude, 'Latitude', 90);
  const longitude = coordinate(merged.longitude, 'Longitude', 180);
  if ((latitude == null) !== (longitude == null)) fail(400, 'Set both latitude and longitude, or leave both blank.');
  return {
    name: required(merged.name, 'Your name', 100),
    organization: required(merged.organization, 'Organization', 160),
    businessType: optional(merged.businessType, 'Business type', 80),
    phone: optional(merged.phone, 'Phone number', 40),
    address: required(merged.address, 'Address', 250),
    city: required(merged.city, 'City', 100),
    latitude, longitude,
    googleMapsUrl: mapsUrl(merged.googleMapsUrl),
  };
}

export function createApp({ dataDir = process.env.DATA_DIR || path.join(ROOT, '.data'), enableRoleAccess, enableDemo, serveStatic = true } = {}) {
  const roleAccessEnabled = enableRoleAccess ?? enableDemo ?? (process.env.ENABLE_ROLE_ACCESS != null
    ? process.env.ENABLE_ROLE_ACCESS === 'true'
    : process.env.ENABLE_DEMO != null ? process.env.ENABLE_DEMO === 'true' : process.env.NODE_ENV !== 'production');
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'match-food.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('donor','charity')), name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE, passwordHash TEXT NOT NULL, organization TEXT NOT NULL,
      businessType TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL,
      city TEXT NOT NULL, latitude REAL, longitude REAL, googleMapsUrl TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expiresAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY, donorId TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
      category TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity > 0), unit TEXT NOT NULL,
      description TEXT NOT NULL, allergens TEXT NOT NULL DEFAULT '[]', availableUntil TEXT NOT NULL,
      pickupWindow TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','reserved','collected')),
      image TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, listingId TEXT NOT NULL REFERENCES listings(id), charityId TEXT NOT NULL REFERENCES users(id),
      message TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity > 0), status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','accepted','declined','completed')), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      UNIQUE(listingId, charityId)
    );
    CREATE INDEX IF NOT EXISTS listings_donor ON listings(donorId);
    CREATE INDEX IF NOT EXISTS requests_charity ON requests(charityId);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expiresAt);
  `);
  const getUser = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const publicUser = (user) => user ? Object.fromEntries(['id', 'role', 'name', 'organization', 'businessType', 'address', 'city', 'latitude', 'longitude', 'googleMapsUrl'].map(k => [k, user[k]])) : null;
  const ownUser = (user) => user ? { ...publicUser(user), email: user.email, phone: user.phone, createdAt: user.createdAt } : null;
  const contact = user => ({ name: user.name, organization: user.organization, email: user.email, phone: user.phone, googleMapsUrl: user.googleMapsUrl });
  const listingJson = (row, coords) => {
    const donor = getUser(row.donorId);
    return { ...row, allergens: JSON.parse(row.allergens), donor: publicUser(donor), latitude: donor.latitude, longitude: donor.longitude,
      distanceKm: coords ? distanceKm(coords.latitude, coords.longitude, donor.latitude, donor.longitude) : null };
  };
  const requestJson = (row, viewer) => {
    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(row.listingId);
    const donor = getUser(listing.donorId), charity = getUser(row.charityId);
    return { ...row, listing: listingJson(listing), donor: publicUser(donor), charity: publicUser(charity),
      contact: viewer.role === 'donor' ? contact(charity) : ['accepted', 'completed'].includes(row.status) ? contact(donor) : null };
  };
  function addUser(values) {
    const user = { id: randomUUID(), createdAt: now(), ...values };
    db.prepare('INSERT INTO users (id, role, name, email, passwordHash, organization, businessType, phone, address, city, latitude, longitude, googleMapsUrl, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, user.role, user.name, user.email, user.passwordHash, user.organization, user.businessType || '', user.phone || '', user.address, user.city, user.latitude ?? null, user.longitude ?? null, user.googleMapsUrl || '', user.createdAt);
    return getUser(user.id);
  }
  // Move only known starter addresses. Keep IDs, profile edits, relationships,
  // and sessions, and never replace an account already using the new address.
  for (const name of ['donor', 'charity', 'produce', 'kitchen']) {
    db.prepare('UPDATE users SET email=? WHERE email=? AND NOT EXISTS (SELECT 1 FROM users WHERE email=?)')
      .run(`${name}@matchfood.example`, `${name}@matchfood.demo`, `${name}@matchfood.example`);
  }
  if (roleAccessEnabled) {
    const starterPassword = passwordHash(randomBytes(24).toString('base64url'));
    const ensureUser = values => db.prepare('SELECT * FROM users WHERE email=?').get(values.email)
      || addUser({...values,passwordHash:starterPassword});
    const donors = [
      ensureUser({role:'donor',name:'Olivia Green',email:'donor@matchfood.example',organization:'The Good Loaf',businessType:'Bakery',phone:'+44 20 7946 0101',address:'42 Borough High Street',city:'London',latitude:51.5055,longitude:-0.0909,googleMapsUrl:'https://www.google.com/maps/search/?api=1&query=Borough+Market+London'}),
      ensureUser({role:'donor',name:'Amir Khan',email:'produce@matchfood.example',organization:'Green Basket Market',businessType:'Grocery store',phone:'+44 20 7946 0102',address:'18 Bermondsey Street',city:'London',latitude:51.5006,longitude:-0.0817,googleMapsUrl:'https://www.google.com/maps/search/?api=1&query=Bermondsey+Street+London'}),
      ensureUser({role:'donor',name:'Sofia Rossi',email:'kitchen@matchfood.example',organization:'Gather Kitchen',businessType:'Restaurant',phone:'+44 20 7946 0103',address:'8 Southwark Bridge Road',city:'London',latitude:51.5061,longitude:-0.0966,googleMapsUrl:'https://www.google.com/maps/search/?api=1&query=Southwark+Bridge+Road+London'}),
    ];
    ensureUser({role:'charity',name:'Jamie Wilson',email:'charity@matchfood.example',organization:'Neighbourhood Table',businessType:'Community charity',phone:'+44 20 7946 0104',address:'12 Union Street',city:'London',latitude:51.5034,longitude:-0.0951,googleMapsUrl:'https://www.google.com/maps/search/?api=1&query=Union+Street+London'});
    ensureUser({role:'charity',name:'Priya Shah',email:'southbank@matchfood.example',organization:'Southbank Community Pantry',businessType:'Community pantry',phone:'+44 20 7946 0105',address:'28 Southwark Street',city:'London',latitude:51.5051,longitude:-0.1060,googleMapsUrl:'https://www.google.com/maps/search/?api=1&query=Southwark+Street+London'});
    ensureUser({role:'charity',name:'Thomas Reed',email:'riverside@matchfood.example',organization:'Riverside Food Hub',businessType:'Food bank',phone:'+44 20 7946 0106',address:'6 Abbey Street',city:'London',latitude:51.4997,longitude:-0.0718,googleMapsUrl:'https://www.google.com/maps/search/?api=1&query=Abbey+Street+London'});
    const hours = n => new Date(Date.now() + n * 60 * 60 * 1000).toISOString();
    const seeds = [
      [donors[0].id,'Freshly baked sourdough & pastries','bakery',24,'items','A lovely mix of sourdough loaves, croissants and morning buns baked fresh today. Perfect for a community breakfast.',['wheat','milk','eggs'],8,'Today, 4:00 PM – 6:00 PM'],
      [donors[1].id,'Seasonal vegetables box','vegetables',15,'kg','Colourful carrots, courgettes, tomatoes and leafy greens. A little wonky, still wonderfully fresh. Great for soups and shared meals.',[],12,'Today, 3:00 PM – 7:00 PM'],
      [donors[2].id,'Wholesome ready-to-share meals','prepared',30,'portions','Freshly prepared vegetarian rice bowls with roasted vegetables. Chilled safely and ready to reheat. Please bring insulated containers.',['sesame'],6,'Today, 5:00 PM – 6:30 PM'],
      [donors[1].id,'Mixed fresh fruit crates','fruit',3,'crates','Apples, oranges and bananas ready for lunchboxes, food parcels or a community kitchen. Each crate holds approximately 5 kg.',[],30,'Tomorrow, 9:00 AM – 12:00 PM'],
      [donors[0].id,'Milk & natural yogurt','dairy',20,'items','Sealed milk bottles and natural yogurt pots, all within date. Keep refrigerated during collection and transport.',['milk'],10,'Today, 4:00 PM – 6:00 PM'],
      [donors[2].id,'Pantry essentials bundle','pantry',12,'kg','Unopened rice, pasta, lentils and tinned tomatoes from our kitchen stock. Ideal for making nourishing meals together.',['wheat'],48,'Tomorrow, 10:00 AM – 4:00 PM'],
    ];
    const insert = db.prepare('INSERT OR IGNORE INTO listings (id,donorId,title,category,quantity,unit,description,allergens,availableUntil,pickupWindow,status,image,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,\'available\',?,?)');
    for (const [donorId,title,category,quantity,unit,description,allergens,expiry,pickupWindow] of seeds) {
      if (getUser(donorId).role === 'donor') insert.run(`demo-${category}`,donorId,title,category,quantity,unit,description,JSON.stringify(allergens),hours(expiry),pickupWindow,category,now());
    }
  }
  // Retained snapshots may be opened days later. Refresh only expired, unclaimed
  // starter food; never silently reopen reserved or collected donations.
  if (roleAccessEnabled) db.prepare("UPDATE listings SET availableUntil=? WHERE id LIKE 'demo-%' AND status='available' AND availableUntil<=?")
    .run(new Date(Date.now()+24*60*60*1000).toISOString(),now());

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { return res.status(403).json({error:'Request origin is not allowed.'}); }
      const ownOrigin = origin.host === req.get('host');
      const configured = process.env.APP_ORIGIN && origin.origin === process.env.APP_ORIGIN;
      const local = process.env.NODE_ENV !== 'production' && ['localhost','127.0.0.1'].includes(origin.hostname);
      if (!ownOrigin && !configured && !local) return res.status(403).json({error:'Request origin is not allowed.'});
    }
    const raw = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('matchfood_session='))?.slice('matchfood_session='.length);
    if (raw && /^[A-Za-z0-9_-]{43}$/.test(raw)) {
      req.sessionHash = hashToken(raw);
      const session = db.prepare('SELECT userId FROM sessions WHERE tokenHash = ? AND expiresAt > ?').get(req.sessionHash, Date.now());
      if (session) req.user = getUser(session.userId);
    }
    next();
  });
  const auth = role => (req, res, next) => {
    if (!req.user) return res.status(401).json({error:'Please log in to continue.'});
    if (role && req.user.role !== role) return res.status(403).json({error:`This action is available to ${role === 'donor' ? 'donors' : 'charities'} only.`});
    next();
  };
  const attempts = new Map();
  const authLimit = (req, res, next) => {
    const key = req.ip;
    const time = Date.now();
    const old = attempts.get(key);
    const entry = !old || old.reset < time ? {count:0,reset:time+60000} : old;
    entry.count++;
    attempts.set(key, entry);
    if (attempts.size > 10000) for (const [k,v] of attempts) if (v.reset < time) attempts.delete(k);
    if (entry.count > 20) return res.status(429).json({error:'Too many attempts. Please try again in a minute.'});
    next();
  };
  const cookieOptions = {httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV === 'production',path:'/'};
  const setSession = (res, user) => {
    const token = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM sessions WHERE expiresAt < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (tokenHash,userId,expiresAt) VALUES (?,?,?)').run(hashToken(token),user.id,Date.now()+SESSION_MS);
    res.cookie('matchfood_session',token,{...cookieOptions,maxAge:SESSION_MS});
  };
  app.get('/api/health', (req,res) => res.json({ok:true,roleAccessEnabled}));
  app.post('/api/auth/register', authLimit, (req,res) => {
    const body = req.body || {};
    if (!['donor','charity'].includes(body.role)) fail(400,'Choose Donor or Charity.');
    const email = required(body.email,'Email',254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,'Enter a valid email address.');
    if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) fail(400,'Use a password between 10 and 128 characters.');
    const fields = profileFields(body);
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) fail(409,'An account with this email already exists.');
    const user = addUser({...fields,role:body.role,email,passwordHash:passwordHash(body.password)});
    setSession(res,user);
    res.status(201).json({user:ownUser(user)});
  });
  app.post('/api/auth/login', authLimit, (req,res) => {
    const body = req.body || {};
    const email = text(body.email).toLowerCase();
    if (typeof body.password !== 'string' || body.password.length > 128) fail(400,'Email and password are required.');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !passwordMatches(body.password,user.passwordHash)) fail(401,'Email or password is incorrect.');
    setSession(res,user);
    res.json({user:ownUser(user)});
  });
  app.post(['/api/auth/role', '/api/auth/demo'], authLimit, (req,res) => {
    if (!roleAccessEnabled) fail(404,'Role access is disabled.');
    if (!['donor','charity'].includes(req.body?.role)) fail(400,'Choose Donor or Charity.');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(`${req.body.role}@matchfood.example`);
    if (!user || user.role !== req.body.role) fail(409,'This workspace is unavailable. Please contact the site administrator.');
    setSession(res,user);
    res.json({user:ownUser(user)});
  });
  app.post('/api/auth/logout', (req,res) => {
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(req.sessionHash);
    res.clearCookie('matchfood_session',cookieOptions).json({ok:true});
  });
  app.get('/api/me', (req,res) => res.json({user:ownUser(req.user),roleAccessEnabled}));
  app.patch('/api/profile', auth(), (req,res) => {
    const profile = profileFields(req.body || {},req.user);
    db.prepare('UPDATE users SET name=?,organization=?,businessType=?,phone=?,address=?,city=?,latitude=?,longitude=?,googleMapsUrl=? WHERE id=?')
      .run(profile.name,profile.organization,profile.businessType,profile.phone,profile.address,profile.city,profile.latitude,profile.longitude,profile.googleMapsUrl,req.user.id);
    res.json({user:ownUser(getUser(req.user.id))});
  });
  const locationFilter = (req, defaults = {}) => {
    const explicit = ['lat','latitude','lng','longitude'].some(key => req.query[key] !== undefined);
    const latitude = coordinate(explicit ? req.query.lat ?? req.query.latitude : defaults.latitude,'Latitude',90);
    const longitude = coordinate(explicit ? req.query.lng ?? req.query.longitude : defaults.longitude,'Longitude',180);
    if ((latitude == null) !== (longitude == null)) fail(400,'Set both latitude and longitude.');
    const radius = req.query.radius == null || req.query.radius === '' ? null : Number(req.query.radius);
    if (radius != null && (!Number.isFinite(radius) || radius <= 0 || radius > 20000)) fail(400,'Choose a valid search radius.');
    if (radius != null && latitude == null) fail(400,'Set your location before searching by distance.');
    return {latitude,longitude,radius,hasCoords:latitude != null};
  };
  app.get('/api/charities', auth('donor'), (req,res) => {
    const {latitude,longitude,radius,hasCoords} = locationFilter(req,req.user);
    const query = text(req.query.q).toLowerCase();
    let charities = db.prepare("SELECT * FROM users WHERE role='charity'").all()
      .map(user => ({...publicUser(user),email:user.email,phone:user.phone,distanceKm:hasCoords ? distanceKm(latitude,longitude,user.latitude,user.longitude) : null}));
    if (query) charities = charities.filter(charity => [charity.organization,charity.name,charity.businessType,charity.city,charity.address].some(value => value.toLowerCase().includes(query)));
    if (radius != null) charities = charities.filter(charity => charity.distanceKm != null && charity.distanceKm <= radius);
    charities.sort((a,b) => hasCoords ? (a.distanceKm ?? Infinity)-(b.distanceKm ?? Infinity) || a.organization.localeCompare(b.organization) : a.organization.localeCompare(b.organization));
    res.json({charities});
  });
  app.get('/api/listings', auth(), (req,res) => {
    const mine = req.user.role === 'donor';
    const {latitude,longitude,radius,hasCoords} = locationFilter(req);
    let rows = db.prepare('SELECT * FROM listings ORDER BY createdAt DESC').all();
    rows = rows.filter(row => mine ? row.donorId === req.user.id : row.status === 'available' && row.availableUntil > now());
    if (CATEGORIES.includes(req.query.category)) rows = rows.filter(row => row.category === req.query.category);
    const query = text(req.query.q).toLowerCase();
    let listings = rows.map(row => listingJson(row,hasCoords ? {latitude,longitude} : null));
    if (query) listings = listings.filter(row => [row.title,row.description,row.donor.organization,row.donor.city,row.category].some(v => v.toLowerCase().includes(query)));
    if (radius != null && hasCoords) listings = listings.filter(row => row.distanceKm != null && row.distanceKm <= radius);
    if (hasCoords) listings.sort((a,b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    res.json({listings});
  });
  const validateListing = (body, old = {}) => {
    const value = {...old,...body};
    if (!CATEGORIES.includes(value.category)) fail(400,'Choose a food category.');
    if (!UNITS.includes(value.unit)) fail(400,'Choose a valid quantity unit.');
    const quantity = Number(value.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) fail(400,'Quantity must be greater than zero and at most 100,000.');
    const date = new Date(value.availableUntil);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) fail(400,'Set an availability time in the future.');
    let allergens = value.allergens;
    if (typeof allergens === 'string' && old.id) { try { allergens = JSON.parse(allergens); } catch { allergens = null; } }
    if (allergens == null) allergens = [];
    if (!Array.isArray(allergens) || allergens.length > 20 || allergens.some(a => typeof a !== 'string' || a.length > 60)) fail(400,'Allergens must be a list of short labels.');
    return {title:required(value.title,'Food title',140),category:value.category,quantity,unit:value.unit,description:required(value.description,'Description',2500),allergens:JSON.stringify(allergens.map(a=>a.trim()).filter(Boolean)),availableUntil:date.toISOString(),pickupWindow:required(value.pickupWindow,'Pickup window',200)};
  };
  app.post('/api/listings', auth('donor'), (req,res) => {
    const listing = {id:randomUUID(),...validateListing(req.body || {}),donorId:req.user.id,status:'available',createdAt:now()};
    db.prepare('INSERT INTO listings (id,donorId,title,category,quantity,unit,description,allergens,availableUntil,pickupWindow,status,image,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(listing.id,listing.donorId,listing.title,listing.category,listing.quantity,listing.unit,listing.description,listing.allergens,listing.availableUntil,listing.pickupWindow,listing.status,listing.category,listing.createdAt);
    res.status(201).json({listing:listingJson(db.prepare('SELECT * FROM listings WHERE id=?').get(listing.id))});
  });
  app.patch('/api/listings/:id', auth('donor'), (req,res) => {
    const row = db.prepare('SELECT * FROM listings WHERE id=?').get(req.params.id);
    if (!row) fail(404,'Food listing not found.');
    if (row.donorId !== req.user.id) fail(403,'You can only update your own listings.');
    const body = req.body || {};
    const status = body.status ?? row.status;
    if (!['available','reserved','collected'].includes(status)) fail(400,'Choose a valid listing status.');
    if (status === 'reserved' && row.status !== 'reserved') fail(409,'Accept a charity request to reserve this listing.');
    if (status === 'available' && db.prepare("SELECT id FROM requests WHERE listingId=? AND status='accepted'").get(row.id)) fail(409,'Complete the accepted collection before making this listing available again.');
    const onlyStatus = Object.keys(body).every(k => k === 'status');
    const value = onlyStatus ? row : validateListing(body,row);
    db.prepare('UPDATE listings SET title=?,category=?,quantity=?,unit=?,description=?,allergens=?,availableUntil=?,pickupWindow=?,status=?,image=? WHERE id=?')
      .run(value.title,value.category,value.quantity,value.unit,value.description,value.allergens,value.availableUntil,value.pickupWindow,status,value.category,row.id);
    if (status === 'collected') db.prepare("UPDATE requests SET status='completed',updatedAt=? WHERE listingId=? AND status='accepted'").run(now(),row.id);
    res.json({listing:listingJson(db.prepare('SELECT * FROM listings WHERE id=?').get(row.id))});
  });
  app.get('/api/requests', auth(), (req,res) => {
    const rows = req.user.role === 'charity' ? db.prepare('SELECT * FROM requests WHERE charityId=? ORDER BY createdAt DESC').all(req.user.id)
      : db.prepare('SELECT r.* FROM requests r JOIN listings l ON l.id=r.listingId WHERE l.donorId=? ORDER BY r.createdAt DESC').all(req.user.id);
    res.json({requests:rows.map(row=>requestJson(row,req.user))});
  });
  app.post('/api/listings/:id/requests', auth('charity'), (req,res) => {
    const listing = db.prepare('SELECT * FROM listings WHERE id=?').get(req.params.id);
    if (!listing) fail(404,'Food listing not found.');
    if (listing.status !== 'available' || listing.availableUntil <= now()) fail(409,'This food is no longer available.');
    const message = required(req.body?.message,'Message',1500);
    if (message.length < 10) fail(400,'Please write a message of at least 10 characters.');
    const quantity = req.body.quantity == null ? listing.quantity : Number(req.body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > listing.quantity) fail(400,'Choose a quantity within the available amount.');
    const existing = db.prepare('SELECT * FROM requests WHERE listingId=? AND charityId=?').get(listing.id,req.user.id);
    if (existing && existing.status !== 'declined') fail(409,'You already have a request for this food.');
    const id = existing?.id || randomUUID();
    if (existing) db.prepare("UPDATE requests SET message=?,quantity=?,status='pending',createdAt=?,updatedAt=? WHERE id=?").run(message,quantity,now(),now(),id);
    else db.prepare("INSERT INTO requests (id,listingId,charityId,message,quantity,status,createdAt,updatedAt) VALUES (?,?,?,?,?,'pending',?,?)").run(id,listing.id,req.user.id,message,quantity,now(),now());
    res.status(201).json({request:requestJson(db.prepare('SELECT * FROM requests WHERE id=?').get(id),req.user)});
  });
  app.patch('/api/requests/:id', auth('donor'), (req,res) => {
    const request = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!request) fail(404,'Collection request not found.');
    const listing = db.prepare('SELECT * FROM listings WHERE id=?').get(request.listingId);
    if (listing.donorId !== req.user.id) fail(403,'You can only manage requests for your food.');
    const status = req.body?.status;
    if (!['accepted','declined','completed'].includes(status)) fail(400,'Choose an accepted, declined or completed status.');
    if (status === 'completed' ? request.status !== 'accepted' : request.status !== 'pending') fail(409,'This request has already been updated.');
    if (status === 'accepted' && (listing.status !== 'available' || listing.availableUntil <= now())) fail(409,'This food is no longer available.');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE requests SET status=?,updatedAt=? WHERE id=?').run(status,now(),request.id);
      if (status === 'accepted') {
        db.prepare("UPDATE listings SET status='reserved' WHERE id=?").run(listing.id);
        db.prepare("UPDATE requests SET status='declined',updatedAt=? WHERE listingId=? AND id<>? AND status='pending'").run(now(),listing.id,request.id);
      }
      if (status === 'completed') db.prepare("UPDATE listings SET status='collected' WHERE id=?").run(listing.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({request:requestJson(db.prepare('SELECT * FROM requests WHERE id=?').get(request.id),req.user)});
  });
  app.get('/api/stats', auth(), (req,res) => {
    const availableListings = db.prepare("SELECT count(*) AS n FROM listings WHERE status='available' AND availableUntil>?").get(now()).n;
    const completed = db.prepare("SELECT r.quantity,l.unit FROM requests r JOIN listings l ON l.id=r.listingId WHERE r.status='completed'").all();
    const weight = item => item.quantity * ({kg:1,crates:5,portions:0.4,items:0.2,loaves:0.5}[item.unit] || 0);
    const foodSavedKg = Math.round(completed.reduce((sum,row)=>sum+weight(row),0)*10)/10;
    const mealsShared = Math.round(completed.reduce((sum,row)=>sum+(row.unit === 'portions' ? row.quantity : weight(row)/0.4),0));
    res.json({availableListings,mealsShared,partnerOrganizations:db.prepare('SELECT count(*) AS n FROM users').get().n,foodSavedKg});
  });
  app.use('/api', (req,res) => res.status(404).json({error:'API endpoint not found.'}));
  const dist = path.join(ROOT,'dist');
  if (serveStatic && existsSync(path.join(dist,'index.html'))) {
    app.use(express.static(dist));
    app.get('/{*path}', (req,res) => res.sendFile(path.join(dist,'index.html')));
  }
  app.use((error,req,res,next) => {
    if (res.headersSent) return next(error);
    const status = error.status || (error.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error('API error:',error.message);
    res.status(status).json({error:status >= 500 ? 'Something went wrong. Please try again.' : error.message});
  });
  return {app,db,close:()=>db.close()};
}
