import type { Id, Listing, RequestItem, Role, User } from './types';

// Browser-only data adapter for the downloadable MatchFood application.
// State is retained locally; the server-backed build continues to use its HTTP API.
type StoredListing = Omit<Listing, 'donor' | 'latitude' | 'longitude' | 'distanceKm'>;
type StoredRequest = Pick<RequestItem, 'id' | 'status' | 'message' | 'quantity' | 'createdAt' | 'updatedAt'> & {
  listingId: Id;
  charityId: Id;
};
interface AppState {
  version: 2;
  users: User[];
  listings: StoredListing[];
  requests: StoredRequest[];
  currentUserId: Id | null;
}

const STORAGE_KEY = 'matchfood-state-v2';
const LEGACY_STORAGE_KEY = 'matchfood-presentation-v1';
const CATEGORIES = ['vegetables', 'fruit', 'bakery', 'prepared', 'dairy', 'pantry'];
const UNITS = ['kg', 'portions', 'items', 'crates', 'loaves'];
let memory: AppState | null = null;
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const sameId = (a: Id | null | undefined, b: Id | null | undefined) => a != null && b != null && String(a) === String(b);
const now = () => new Date().toISOString();
const makeId = () => globalThis.crypto?.randomUUID?.() || `matchfood-${Date.now()}-${Math.random().toString(36).slice(2)}`;
function fail(message: string): never { throw new Error(message); }

function persist(state: AppState) {
  memory = state;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {
    // Browsers may disable storage for file:// pages. The current session still works.
  }
}

const oldEmails: Record<string, string> = Object.fromEntries(['donor', 'charity', 'produce', 'kitchen'].map(name => [`${name}@matchfood.demo`, `${name}@matchfood.example`]));
const normalizedEmail = (email: string) => oldEmails[email.toLowerCase()] || email.toLowerCase();

function state(): AppState {
  if (memory) return memory;
  const globals = globalThis as typeof globalThis & {
    __MATCHFOOD_DATA__?: Omit<AppState, 'version'>;
    __MATCHFOOD_DEMO_DATA__?: Omit<AppState, 'version'>;
  };
  const seed = globals.__MATCHFOOD_DATA__ || globals.__MATCHFOOD_DEMO_DATA__;
  for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
    try {
      const stored = JSON.parse(localStorage.getItem(key) || 'null') as (Omit<AppState, 'version'> & { version: number }) | null;
      if (stored && [1, 2].includes(stored.version) && Array.isArray(stored.users) && stored.users.length && Array.isArray(stored.listings) && Array.isArray(stored.requests)) {
        memory = { ...stored, version: 2 };
        break;
      }
    } catch { /* Missing or unavailable browser storage falls back to bundled data. */ }
  }
  if (!memory) {
    if (!seed?.users?.length || !Array.isArray(seed.listings)) fail('MatchFood data is missing. Please rebuild the application file.');
    memory = { ...copy(seed), version: 2, currentUserId: null, requests: [] };
    memory.listings = memory.listings.map((listing, index) => {
      const originalHours = (Date.parse(listing.availableUntil) - Date.parse(listing.createdAt)) / 3_600_000;
      const hours = Number.isFinite(originalHours) ? Math.max(6, Math.min(48, originalHours)) : 24;
      return {
        ...listing,
        allergens: typeof listing.allergens === 'string' ? JSON.parse(listing.allergens) : listing.allergens || [],
        createdAt: new Date(Date.now() - index * 1000).toISOString(),
        availableUntil: new Date(Date.now() + hours * 3_600_000).toISOString()
      };
    });
  }
  // Preserve edited profiles and all IDs while adopting the current directory.
  for (const user of memory.users) {
    const nextEmail = oldEmails[user.email.toLowerCase()];
    if (nextEmail && !memory.users.some(other => !sameId(other.id, user.id) && other.email.toLowerCase() === nextEmail)) user.email = nextEmail;
  }
  for (const user of seed?.users || []) {
    if (!memory.users.some(existing => sameId(existing.id, user.id) || normalizedEmail(existing.email) === normalizedEmail(user.email))) memory.users.push(copy(user));
  }
  const bundledIds = new Set((seed?.listings || []).map(listing => String(listing.id)));
  for (const listing of memory.listings) {
    if ((bundledIds.has(String(listing.id)) || String(listing.id).startsWith('demo-')) && listing.status === 'available' && Date.parse(listing.availableUntil) <= Date.now()) {
      listing.availableUntil = new Date(Date.now() + 24 * 3_600_000).toISOString();
      listing.pickupWindow = 'Arrange a collection time with the donor';
    }
  }
  persist(memory);
  return memory;
}

function required(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label} is required and must be at most ${max} characters.`);
  return value.trim();
}
function optional(value: unknown, label: string, max = 200): string {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.trim().length > max) fail(`${label} must be at most ${max} characters.`);
  return value.trim();
}
function coordinate(value: unknown, label: string, limit: number): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > limit) fail(`${label} is invalid.`);
  return number;
}
function mapsLink(value: unknown): string {
  const text = optional(value, 'Google Maps link', 1000);
  if (!text) return '';
  let url: URL;
  try { url = new URL(text); } catch { return fail('Enter a valid Google Maps URL.'); }
  const short = ['maps.app.goo.gl', 'goo.gl'].includes(url.hostname);
  const google = /^(www\.|maps\.)?google\.(com|co\.uk|ro)$/.test(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || !(short || google && (url.hostname.startsWith('maps.') || url.pathname.startsWith('/maps')))) fail('Use a secure Google Maps profile or place link.');
  return url.toString();
}
function currentUser(data: AppState, role?: Role): User {
  const user = data.users.find(user => sameId(user.id, data.currentUserId));
  if (!user) return fail('Choose Donor or Charity to continue.');
  if (role && user.role !== role) fail(`This action is available to ${role === 'donor' ? 'donors' : 'charities'} only.`);
  return user;
}
function findListing(data: AppState, id: string): StoredListing {
  return data.listings.find(listing => sameId(listing.id, id)) || fail('Food listing not found.');
}
function publicUser(user: User): User {
  const { email: _email, phone: _phone, ...profile } = user;
  return profile as User;
}
function contact(user: User) {
  return { name: user.name, organization: user.organization, email: user.email, phone: user.phone, googleMapsUrl: user.googleMapsUrl };
}
function distance(latitude: number | null, longitude: number | null, otherLatitude: number | null, otherLongitude: number | null): number | null {
  if (latitude == null || longitude == null || otherLatitude == null || otherLongitude == null) return null;
  const radians = (n: number) => n * Math.PI / 180;
  const a = Math.sin(radians(otherLatitude - latitude) / 2) ** 2 + Math.cos(radians(latitude)) * Math.cos(radians(otherLatitude)) * Math.sin(radians(otherLongitude - longitude) / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))) * 10) / 10;
}
function listingJson(data: AppState, listing: StoredListing, latitude: number | null = null, longitude: number | null = null): Listing {
  const donor = data.users.find(user => sameId(user.id, listing.donorId)) || fail('The donor profile is unavailable.');
  return { ...listing, donor: publicUser(donor), latitude: donor.latitude, longitude: donor.longitude, distanceKm: distance(latitude, longitude, donor.latitude, donor.longitude) };
}
function requestJson(data: AppState, request: StoredRequest, viewer: User): RequestItem {
  const listing = findListing(data, String(request.listingId));
  const donor = data.users.find(user => sameId(user.id, listing.donorId)) || fail('The donor profile is unavailable.');
  const charity = data.users.find(user => sameId(user.id, request.charityId)) || fail('The charity profile is unavailable.');
  return { ...request, listing: listingJson(data, listing), donor: publicUser(donor), charity: publicUser(charity), contact: viewer.role === 'donor' ? contact(charity) : ['accepted', 'completed'].includes(request.status) ? contact(donor) : null };
}
function validateListing(body: Record<string, unknown>): Omit<StoredListing, 'id' | 'donorId' | 'status' | 'createdAt'> {
  const category = String(body.category || '');
  const unit = String(body.unit || '');
  if (!CATEGORIES.includes(category)) fail('Choose a food category.');
  if (!UNITS.includes(unit)) fail('Choose a valid quantity unit.');
  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) fail('Quantity must be greater than zero and at most 100,000.');
  const availableUntil = new Date(String(body.availableUntil));
  if (!Number.isFinite(availableUntil.getTime()) || availableUntil.getTime() <= Date.now()) fail('Set an availability time in the future.');
  const allergens = body.allergens ?? [];
  if (!Array.isArray(allergens) || allergens.length > 20 || allergens.some(value => typeof value !== 'string' || value.length > 60)) fail('Allergens must be a list of short labels.');
  return { title: required(body.title, 'Food title', 140), category, quantity, unit, description: required(body.description, 'Description', 2500), allergens: (allergens as string[]).map(value => value.trim()).filter(Boolean), availableUntil: availableUntil.toISOString(), pickupWindow: required(body.pickupWindow, 'Pickup window', 200), image: category };
}

export async function standaloneApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const data = state();
  const url = new URL(path, 'https://matchfood.invalid');
  const route = url.pathname;
  const query = url.searchParams;
  const method = (options.method || 'GET').toUpperCase();
  let body: Record<string, unknown> = {};
  if (typeof options.body === 'string') {
    try { body = JSON.parse(options.body); } catch { fail('The form could not be read. Please try again.'); }
  }
  let result: unknown;

  if (route === '/health' && method === 'GET') result = { ok: true, roleAccessEnabled: true };
  else if (route === '/me' && method === 'GET') result = { user: data.users.find(user => sameId(user.id, data.currentUserId)) || null, roleAccessEnabled: true };
  else if (route === '/auth/role' && method === 'POST') {
    if (!['donor', 'charity'].includes(String(body.role))) fail('Choose Donor or Charity.');
    const user = data.users.find(user => user.email === `${body.role}@matchfood.example`) || data.users.find(user => user.email === `${body.role}@matchfood.demo`) || data.users.find(user => user.role === body.role) || fail('This role is unavailable.');
    data.currentUserId = user.id;
    result = { user };
  } else if (route === '/auth/logout' && method === 'POST') {
    data.currentUserId = null;
    result = { ok: true };
  } else if (route === '/profile' && method === 'PATCH') {
    const user = currentUser(data);
    const merged = { ...user, ...body };
    const latitude = coordinate(merged.latitude, 'Latitude', 90);
    const longitude = coordinate(merged.longitude, 'Longitude', 180);
    if ((latitude == null) !== (longitude == null)) fail('Set both latitude and longitude, or leave both blank.');
    Object.assign(user, { name: required(merged.name, 'Your name', 100), organization: required(merged.organization, 'Organisation', 160), businessType: optional(merged.businessType, 'Business type', 80), phone: optional(merged.phone, 'Phone number', 40), address: required(merged.address, 'Address', 250), city: required(merged.city, 'City', 100), latitude, longitude, googleMapsUrl: mapsLink(merged.googleMapsUrl) });
    result = { user };
  } else if (route === '/listings' && method === 'GET') {
    const viewer = currentUser(data);
    if ((query.has('lat') || query.has('latitude')) !== (query.has('lng') || query.has('longitude'))) fail('Set both latitude and longitude.');
    const latitude = coordinate(query.get('lat') ?? query.get('latitude'), 'Latitude', 90);
    const longitude = coordinate(query.get('lng') ?? query.get('longitude'), 'Longitude', 180);
    if ((latitude == null) !== (longitude == null)) fail('Set both latitude and longitude.');
    const radius = query.has('radius') ? Number(query.get('radius')) : null;
    if (radius != null && (!Number.isFinite(radius) || radius <= 0 || radius > 20000)) fail('Choose a valid search radius.');
    if (radius != null && latitude == null) fail('Set your location before searching within a distance.');
    let rows = data.listings.filter(listing => viewer.role === 'donor' ? sameId(listing.donorId, viewer.id) : listing.status === 'available' && Date.parse(listing.availableUntil) > Date.now());
    if (CATEGORIES.includes(query.get('category') || '')) rows = rows.filter(listing => listing.category === query.get('category'));
    const search = (query.get('q') || '').trim().toLowerCase();
    let listings = rows.map(listing => listingJson(data, listing, latitude, longitude));
    if (search) listings = listings.filter(listing => [listing.title, listing.description, listing.donor.organization, listing.donor.city, listing.category].some(value => value.toLowerCase().includes(search)));
    if (latitude != null && radius != null) listings = listings.filter(listing => listing.distanceKm != null && listing.distanceKm <= radius);
    listings.sort((a, b) => latitude != null ? (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) : Date.parse(b.createdAt) - Date.parse(a.createdAt));
    result = { listings };
  } else if (route === '/charities' && method === 'GET') {
    const viewer = currentUser(data, 'donor');
    const hasLatitude = query.has('lat') || query.has('latitude');
    const hasLongitude = query.has('lng') || query.has('longitude');
    if (hasLatitude !== hasLongitude) fail('Set both latitude and longitude.');
    const latitude = coordinate(hasLatitude ? query.get('lat') ?? query.get('latitude') : viewer.latitude, 'Latitude', 90);
    const longitude = coordinate(hasLongitude ? query.get('lng') ?? query.get('longitude') : viewer.longitude, 'Longitude', 180);
    if ((latitude == null) !== (longitude == null)) fail('Set both latitude and longitude.');
    const radius = query.has('radius') ? Number(query.get('radius')) : null;
    if (radius != null && (!Number.isFinite(radius) || radius <= 0 || radius > 20000)) fail('Choose a valid search radius.');
    if (radius != null && latitude == null) fail('Set your location before searching within a distance.');
    const search = (query.get('q') || '').trim().toLowerCase();
    let charities = data.users.filter(user => user.role === 'charity').map(user => ({ ...publicUser(user), email: user.email, phone: user.phone, distanceKm: distance(latitude, longitude, user.latitude, user.longitude) }));
    if (search) charities = charities.filter(charity => [charity.organization, charity.name, charity.address, charity.city, charity.businessType].some(value => value.toLowerCase().includes(search)));
    if (radius != null) charities = charities.filter(charity => charity.distanceKm != null && charity.distanceKm <= radius);
    charities.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || a.organization.localeCompare(b.organization));
    result = { charities };
  } else if (route === '/listings' && method === 'POST') {
    const user = currentUser(data, 'donor');
    const listing: StoredListing = { ...validateListing(body), id: makeId(), donorId: user.id, status: 'available', createdAt: now() };
    data.listings.push(listing);
    result = { listing: listingJson(data, listing) };
  } else if (/^\/listings\/[^/]+$/.test(route) && method === 'PATCH') {
    const user = currentUser(data, 'donor');
    const listing = findListing(data, decodeURIComponent(route.split('/')[2]));
    if (!sameId(listing.donorId, user.id)) fail('You can only update your own listings.');
    const status = body.status ?? listing.status;
    if (!['available', 'reserved', 'collected'].includes(String(status))) fail('Choose a valid listing status.');
    if (status === 'reserved' && listing.status !== 'reserved') fail('Accept a charity request to reserve this listing.');
    if (status === 'available' && data.requests.some(request => sameId(request.listingId, listing.id) && request.status === 'accepted')) fail('Complete the accepted collection before making this listing available again.');
    if (Object.keys(body).some(key => key !== 'status')) Object.assign(listing, validateListing({ ...listing, ...body }));
    listing.status = status as StoredListing['status'];
    if (status === 'collected') for (const request of data.requests) if (sameId(request.listingId, listing.id) && request.status === 'accepted') { request.status = 'completed'; request.updatedAt = now(); }
    result = { listing: listingJson(data, listing) };
  } else if (route === '/requests' && method === 'GET') {
    const user = currentUser(data);
    const requests = data.requests.filter(request => user.role === 'charity' ? sameId(request.charityId, user.id) : sameId(findListing(data, String(request.listingId)).donorId, user.id)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    result = { requests: requests.map(request => requestJson(data, request, user)) };
  } else if (/^\/listings\/[^/]+\/requests$/.test(route) && method === 'POST') {
    const user = currentUser(data, 'charity');
    const listing = findListing(data, decodeURIComponent(route.split('/')[2]));
    if (listing.status !== 'available' || Date.parse(listing.availableUntil) <= Date.now()) fail('This food is no longer available.');
    const message = required(body.message, 'Message', 1500);
    if (message.length < 10) fail('Please write a message of at least 10 characters.');
    const quantity = body.quantity == null ? listing.quantity : Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > listing.quantity) fail('Choose a quantity within the available amount.');
    const existing = data.requests.find(request => sameId(request.listingId, listing.id) && sameId(request.charityId, user.id));
    if (existing && existing.status !== 'declined') fail('You already have a request for this food.');
    const request: StoredRequest = existing || { id: makeId(), listingId: listing.id, charityId: user.id, message, quantity, status: 'pending', createdAt: now(), updatedAt: now() };
    Object.assign(request, { message, quantity, status: 'pending', createdAt: now(), updatedAt: now() });
    if (!existing) data.requests.push(request);
    result = { request: requestJson(data, request, user) };
  } else if (/^\/requests\/[^/]+$/.test(route) && method === 'PATCH') {
    const user = currentUser(data, 'donor');
    const request = data.requests.find(request => sameId(request.id, decodeURIComponent(route.split('/')[2]))) || fail('Collection request not found.');
    const listing = findListing(data, String(request.listingId));
    if (!sameId(listing.donorId, user.id)) fail('You can only manage requests for your food.');
    const status = body.status;
    if (!['accepted', 'declined', 'completed'].includes(String(status))) fail('Choose an accepted, declined or completed status.');
    if (status === 'completed' ? request.status !== 'accepted' : request.status !== 'pending') fail('This request has already been updated.');
    if (status === 'accepted' && (listing.status !== 'available' || Date.parse(listing.availableUntil) <= Date.now())) fail('This food is no longer available.');
    request.status = status as StoredRequest['status'];
    request.updatedAt = now();
    if (status === 'accepted') {
      listing.status = 'reserved';
      for (const other of data.requests) if (sameId(other.listingId, listing.id) && !sameId(other.id, request.id) && other.status === 'pending') { other.status = 'declined'; other.updatedAt = now(); }
    }
    if (status === 'completed') listing.status = 'collected';
    result = { request: requestJson(data, request, user) };
  } else if (route === '/stats' && method === 'GET') {
    currentUser(data);
    const completed = data.requests.filter(request => request.status === 'completed');
    const weights: Record<string, number> = { kg: 1, crates: 5, portions: 0.4, items: 0.2, loaves: 0.5 };
    const weight = (request: StoredRequest) => request.quantity * (weights[findListing(data, String(request.listingId)).unit] || 0);
    result = { availableListings: data.listings.filter(listing => listing.status === 'available' && Date.parse(listing.availableUntil) > Date.now()).length, mealsShared: Math.round(completed.reduce((total, request) => total + (findListing(data, String(request.listingId)).unit === 'portions' ? request.quantity : weight(request) / 0.4), 0)), partnerOrganizations: data.users.length, foodSavedKg: Math.round(completed.reduce((total, request) => total + weight(request), 0) * 10) / 10 };
  } else fail('This action is unavailable. Please try another option.');

  persist(data);
  return copy(result) as T;
}
