import { useState } from 'react';
import type { FormEvent } from 'react';
import { ExternalLink, LocateFixed, MapPin } from 'lucide-react';
import { patch, post } from '../api';
import { CATEGORIES, CITIES } from '../types';
import type { Listing, User } from '../types';

function mapsCoordinates(value: string): { latitude: string; longitude: string } | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (!(host === 'google.com' || host.endsWith('.google.com') || host === 'maps.app.goo.gl' || host === 'goo.gl')) return null;
  const coordinates = value.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
    || value.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/)
    || (url.searchParams.get('q') || url.searchParams.get('query') || '').match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (!coordinates) return null;
  const [, latitude, longitude] = coordinates;
  if (Math.abs(Number(latitude)) > 90 || Math.abs(Number(longitude)) > 180) return null;
  return { latitude, longitude };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : 'We couldn’t save your changes. Please try again.';
}

const BUSINESS_TYPES = ['Bakery', 'Restaurant', 'Café', 'Supermarket', 'Farm', 'School or institution', 'Other'];

export function ProfileForm({ user, onSaved, onCancel }: {
  user: User;
  onSaved: (user: User) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    name: user.name || '',
    organization: user.organization || '',
    businessType: user.businessType || 'Other',
    phone: user.phone || '',
    address: user.address || '',
    city: user.city || '',
    latitude: user.latitude == null ? '' : String(user.latitude),
    longitude: user.longitude == null ? '' : String(user.longitude),
    googleMapsUrl: user.googleMapsUrl || ''
  });
  const [pending, setPending] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const [locationNote, setLocationNote] = useState('');

  const update = (field: keyof typeof form, value: string) => setForm(current => ({ ...current, [field]: value }));
  const updateCity = (city: string) => {
    const preset = CITIES.find(item => item.label.toLowerCase() === city.trim().toLowerCase());
    setForm(current => ({ ...current, city, ...(preset ? { latitude: String(preset.latitude), longitude: String(preset.longitude) } : { latitude: '', longitude: '' }) }));
    setLocationNote(preset ? `Using the centre of ${preset.label}. Use your current location for a closer match.` : 'Use your current location or enter coordinates to find food near this city.');
  };
  const useLocation = () => {
    if (!navigator.geolocation) { setLocationNote('Your browser does not support location sharing. You can enter coordinates below.'); return; }
    setLocating(true);
    setLocationNote('');
    navigator.geolocation.getCurrentPosition(position => {
      setForm(current => ({ ...current, latitude: position.coords.latitude.toFixed(6), longitude: position.coords.longitude.toFixed(6) }));
      setLocationNote('Your current location is selected. Check that your address is correct, then save your profile.');
      setLocating(false);
    }, () => {
      setLocationNote('We couldn’t access your location. Choose a supported city or enter coordinates below.');
      setLocating(false);
    }, { timeout: 10000, maximumAge: 60000 });
  };
  const readMapLocation = () => {
    const coordinates = mapsCoordinates(form.googleMapsUrl);
    if (coordinates) {
      setForm(current => ({ ...current, ...coordinates }));
      setLocationNote('Location taken from your Google Maps link.');
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    if (!!form.latitude !== !!form.longitude) {
      setError('Please enter both latitude and longitude, or leave both empty.');
      return;
    }
    setPending(true);
    try {
      const { user: saved } = await patch<{ user: User }>('/profile', {
        ...form,
        latitude: form.latitude === '' ? null : Number(form.latitude),
        longitude: form.longitude === '' ? null : Number(form.longitude)
      });
      onSaved(saved);
    } catch (error) { setError(message(error)); }
    finally { setPending(false); }
  };

  return <form onSubmit={submit}>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="form-grid">
      <label className="field"><span>Your name</span><input className="input" name="name" autoComplete="name" required maxLength={100} value={form.name} onChange={event => update('name', event.target.value)} /></label>
      <label className="field"><span>{user.role === 'donor' ? 'Business or institution' : 'Charity name'}</span><input className="input" name="organization" autoComplete="organization" required maxLength={160} value={form.organization} onChange={event => update('organization', event.target.value)} /></label>
      {user.role === 'donor' && <label className="field"><span>Type of business</span><select className="input" name="businessType" value={form.businessType} onChange={event => update('businessType', event.target.value)}>
        {!BUSINESS_TYPES.includes(form.businessType) && <option value={form.businessType}>{form.businessType}</option>}
        {BUSINESS_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
      </select></label>}
      <label className={`field ${user.role === 'charity' ? 'full' : ''}`}><span>Contact phone <small>(optional)</small></span><input className="input" type="tel" name="phone" autoComplete="tel" maxLength={40} value={form.phone} onChange={event => update('phone', event.target.value)} /></label>
      <label className="field full"><span>Street address</span><input className="input" name="address" autoComplete="street-address" required maxLength={240} value={form.address} onChange={event => update('address', event.target.value)} /></label>
      <label className="field full"><span>Town or city</span><input className="input" name="city" list="profile-city-suggestions" autoComplete="address-level2" required maxLength={100} value={form.city} onChange={event => updateCity(event.target.value)} />
        <datalist id="profile-city-suggestions">{CITIES.map(city => <option key={city.label} value={city.label} />)}</datalist>
      </label>
      <div className="field full"><button className="btn secondary" type="button" disabled={locating || pending} onClick={useLocation}><LocateFixed size={17} />{locating ? 'Finding your location…' : 'Use my current location'}</button>
        {locationNote && <p className="field-help" role="status">{locationNote}</p>}
      </div>
      <label className="field full"><span>Google Maps place link <small>(optional)</small></span><input className="input" type="url" name="googleMapsUrl" placeholder="https://maps.google.com/…" maxLength={2000} value={form.googleMapsUrl} onChange={event => update('googleMapsUrl', event.target.value)} onBlur={readMapLocation} /><span className="field-help">Paste your business or organisation’s Maps link.</span></label>
      <details className="field full"><summary><MapPin size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />Location coordinates</summary>
        <p className="field-help">Nearby food uses these coordinates. Choose a suggested city, use your location, or enter a precise map position.</p>
        <div className="form-grid" style={{ marginTop: 12 }}>
          <label className="field"><span>Latitude</span><input className="input" name="latitude" type="number" min={-90} max={90} step="any" value={form.latitude} onChange={event => update('latitude', event.target.value)} /></label>
          <label className="field"><span>Longitude</span><input className="input" name="longitude" type="number" min={-180} max={180} step="any" value={form.longitude} onChange={event => update('longitude', event.target.value)} /></label>
        </div>
        <a className="field-help" href="https://www.google.com/maps" target="_blank" rel="noreferrer">Find a location on Google Maps <ExternalLink size={12} style={{ verticalAlign: 'middle' }} /></a>
      </details>
    </div>
    <div className="modal-footer"><button className="btn secondary" type="button" onClick={onCancel} disabled={pending}>Cancel</button><button className="btn primary" type="submit" disabled={pending || locating}>{pending ? 'Saving…' : 'Save profile'}</button></div>
  </form>;
}

function tomorrowEvening() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(18, 0, 0, 0);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const ALLERGENS = ['Gluten', 'Milk', 'Eggs', 'Nuts', 'Soy', 'Sesame'];

export function ListingForm({ onSaved, onCancel }: {
  onSaved: (listing: Listing) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({ title: '', category: 'bakery', quantity: '10', unit: 'items', description: '', availableUntil: tomorrowEvening(), pickupWindow: '' });
  const [allergens, setAllergens] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const update = (field: keyof typeof form, value: string) => setForm(current => ({ ...current, [field]: value }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    const availableUntil = new Date(form.availableUntil);
    if (!Number.isFinite(availableUntil.getTime()) || availableUntil.getTime() <= Date.now()) {
      setError('Please choose a collection deadline in the future.');
      return;
    }
    setPending(true);
    try {
      const { listing } = await post<{ listing: Listing }>('/listings', { ...form, quantity: Number(form.quantity), allergens, availableUntil: availableUntil.toISOString() });
      onSaved(listing);
    } catch (error) { setError(message(error)); }
    finally { setPending(false); }
  };
  return <form onSubmit={submit}>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="form-grid">
      <label className="field full"><span>What are you sharing?</span><input className="input" name="title" required minLength={3} maxLength={160} placeholder="e.g. Fresh sourdough and pastries" value={form.title} onChange={event => update('title', event.target.value)} /></label>
      <label className="field full"><span>Food category</span><select className="input" name="category" value={form.category} onChange={event => update('category', event.target.value)}>{CATEGORIES.filter(category => category.id !== 'all').map(category => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label>
      <label className="field"><span>Quantity available</span><input className="input" name="quantity" type="number" min={0.01} max={100000} step="any" required value={form.quantity} onChange={event => update('quantity', event.target.value)} /></label>
      <label className="field"><span>Unit</span><select className="input" name="unit" value={form.unit} onChange={event => update('unit', event.target.value)}>{['items', 'kg', 'portions', 'crates', 'loaves'].map(unit => <option key={unit} value={unit}>{unit}</option>)}</select></label>
      <label className="field full"><span>A little more about the food</span><textarea className="input" name="description" rows={3} required minLength={10} maxLength={2000} placeholder="What’s included, how it’s packed, and any collection notes…" value={form.description} onChange={event => update('description', event.target.value)} /></label>
      <fieldset className="field full" style={{ border: 0, margin: 0, padding: 0 }}><legend style={{ marginBottom: 10 }}>Contains these allergens</legend><div className="tag-list">{ALLERGENS.map(allergen => <label className="checkbox-row" key={allergen}><input type="checkbox" checked={allergens.includes(allergen)} onChange={() => setAllergens(current => current.includes(allergen) ? current.filter(item => item !== allergen) : [...current, allergen])} />{allergen}</label>)}</div><p className="field-help">Share all known allergens in the description, including any not listed here.</p></fieldset>
      <label className="field"><span>Collect before</span><input className="input" name="availableUntil" type="datetime-local" required value={form.availableUntil} onChange={event => update('availableUntil', event.target.value)} /></label>
      <label className="field"><span>Collection window</span><input className="input" name="pickupWindow" required maxLength={160} placeholder="e.g. Today, 4–6 pm" value={form.pickupWindow} onChange={event => update('pickupWindow', event.target.value)} /></label>
    </div>
    <div className="modal-footer"><button className="btn secondary" type="button" onClick={onCancel} disabled={pending}>Cancel</button><button className="btn primary" type="submit" disabled={pending}>{pending ? 'Sharing…' : 'Share food'}</button></div>
  </form>;
}
