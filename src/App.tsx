import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ArrowRight, ArrowUpRight, Bell, Check, ChevronDown, ChevronRight, Clock,
  Compass, ExternalLink, Heart, HeartHandshake, HelpCircle, Leaf, LogOut,
  Mail, MapPin, MessageCircle, Navigation, Package, Plus, Search, Settings,
  ShieldCheck, ShoppingBag, Sprout, Users, UtensilsCrossed, Wheat, X
} from 'lucide-react';
import { api, patch, post } from './api';
import { foodImage } from './artwork';
import { CATEGORIES, CITIES } from './types';
import type { Area, Charity, Id, Listing, RequestItem, Role, User } from './types';
import { ListingForm, ProfileForm } from './components/Forms';

type View = 'home' | 'donations' | 'charities' | 'requests' | 'saved' | 'how';
type ModalName = 'profile' | 'create' | 'location' | 'detail' | null;
const categoryLabels = Object.fromEntries(CATEGORIES.map(category => [category.id, category.label]));
const categoryIcons: Record<string, typeof Leaf> = {
  all: UtensilsCrossed, vegetables: Sprout, fruit: Leaf, bakery: Wheat,
  prepared: UtensilsCrossed, dairy: ShoppingBag, pantry: Package
};
const quantityLabel = (quantity: number, unit: string) => `${quantity} ${unit === 'kg' || quantity !== 1 ? unit : ({ portions: 'portion', items: 'item', crates: 'crate', loaves: 'loaf' }[unit] || unit)}`;
const organisationMaps = (organisation: Pick<User, 'organization' | 'address' | 'city' | 'googleMapsUrl'>) => organisation.googleMapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${organisation.organization}, ${organisation.address}, ${organisation.city}`)}`;
function deadlineLabel(value: string) {
  const date = new Date(value);
  const day = date.toDateString() === new Date().toDateString() ? 'Today'
    : date.toDateString() === new Date(Date.now() + 86400000).toDateString() ? 'Tomorrow'
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${day}, ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}
function useDebounced(value: string) {
  const [result, setResult] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setResult(value), 250); return () => clearTimeout(timer); }, [value]);
  return result;
}

function Brand({ onClick }: { onClick?: () => void }) {
  const content = <>
    <span className="brand-mark"><Sprout size={24} /></span>
    <span>match<span style={{ fontWeight: 400 }}>food</span><span className="brand-dot">.</span></span>
  </>;
  return onClick ? <button className="brand" onClick={onClick} aria-label="MatchFood home">{content}</button> : <div className="brand">{content}</div>;
}

function Dialog({ title, children, onClose, wide = false }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab') return;
      const elements = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]');
      if (!elements?.length) return;
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', handler);
      previous?.focus();
    };
  }, []);
  return <div className="modal-backdrop" onClick={onClose}>
    <div ref={ref} tabIndex={-1} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={event => event.stopPropagation()}>
      <div className="modal-header"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X /></button></div>
      <div className="modal-body">{children}</div>
    </div>
  </div>;
}

function FoodCard({ listing, saved, onSave, onOpen }: {
  listing: Listing; saved?: boolean; onSave?: () => void; onOpen: () => void;
}) {
  return <article className="food-card">
    <div className="food-image">
      <img src={foodImage(listing.category)} alt={`${categoryLabels[listing.category] || 'Food'} from ${listing.donor.organization}`} loading="lazy" />
      <div className="food-image-top">
        <span className={`food-badge ${listing.status !== 'available' ? 'reserved' : ''}`}><span className="status-dot" />{listing.status === 'available' ? 'Available now' : listing.status === 'collected' ? 'Collected' : 'Reserved'}</span>
        {onSave && <button className={`favorite-btn ${saved ? 'is-saved' : ''}`} onClick={onSave} aria-label={`${saved ? 'Unsave' : 'Save'} ${listing.title}`} aria-pressed={!!saved}><Heart size={17} fill={saved ? 'currentColor' : 'none'} /></button>}
      </div>
    </div>
    <div className="food-content">
      <div className="food-category">{categoryLabels[listing.category]}</div>
      <h3 className="food-title"><button onClick={onOpen}>{listing.title}</button></h3>
      <div className="food-donor"><span className="donor-dot" />{listing.donor.organization}<ShieldCheck size={13} aria-label="Community donor" /></div>
      <div className="food-meta"><Clock size={14} /><span>Collect {deadlineLabel(listing.availableUntil).toLowerCase()}</span></div>
      <div className="food-footer"><div><strong className="food-quantity">{quantityLabel(listing.quantity, listing.unit)}</strong><span className="food-distance"><MapPin size={12} />{listing.distanceKm != null ? `${listing.distanceKm.toFixed(1)} km away` : listing.donor.city}</span></div><button className="card-action" aria-label={`View ${listing.title}`} onClick={onOpen}><ArrowUpRight size={21} /></button></div>
    </div>
  </article>;
}

function CharityCard({ charity }: { charity: Charity }) {
  return <article className="charity-card">
    <div className="charity-card-header"><span className="charity-icon"><HeartHandshake size={25} /></span><span className="charity-distance"><MapPin size={13} />{charity.distanceKm != null ? `${charity.distanceKm.toFixed(1)} km away` : charity.city}</span></div>
    <h3>{charity.organization}</h3>
    <p className="charity-type">{charity.businessType || 'Community charity'}</p>
    <p className="charity-meta"><MapPin size={15} />{charity.address}, {charity.city}</p>
    <p className="charity-meta"><Users size={15} />{charity.name}</p>
    <div className="charity-actions">
      <a className="btn primary small" href={`mailto:${charity.email}`}><Mail size={14} />Contact charity</a>
      <a className="btn secondary small" href={organisationMaps(charity)} target="_blank" rel="noreferrer">View location <ExternalLink size={13} /></a>
    </div>
  </article>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false), [roleChosen, setRoleChosen] = useState(false);
  const [roleAccessEnabled, setRoleAccessEnabled] = useState(true);
  const [view, setView] = useState<View>('home');
  const [modal, setModal] = useState<ModalName>(null), [selected, setSelected] = useState<Listing | null>(null);
  const [area, setArea] = useState<Area | null>(null), [radius, setRadius] = useState(10), [city, setCity] = useState('London');
  const [category, setCategory] = useState('all'), [foodSearch, setFoodSearch] = useState(''), [charitySearch, setCharitySearch] = useState(''), [sort, setSort] = useState('nearby');
  const search = useDebounced(foodSearch), charityQuery = useDebounced(charitySearch);
  const [listings, setListings] = useState<Listing[]>([]), [charities, setCharities] = useState<Charity[]>([]), [requests, setRequests] = useState<RequestItem[]>([]);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [entryError, setEntryError] = useState(''), [modalError, setModalError] = useState(''), [toast, setToast] = useState('');
  const [message, setMessage] = useState(''), [requestQuantity, setRequestQuantity] = useState(1), [requestTab, setRequestTab] = useState('all');
  const [saved, setSaved] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('matchfood-saved') || '[]'); } catch { return []; } });
  const loadVersion = useRef(0), toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4500);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  useEffect(() => {
    let cancelled = false;
    api<{ user: User | null; roleAccessEnabled: boolean }>('/me').then(data => {
      if (!cancelled) { setUser(data.user); setRoleAccessEnabled(data.roleAccessEnabled); }
    }).catch(reason => { if (!cancelled) setEntryError(reason.message); }).finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { try { localStorage.setItem('matchfood-saved', JSON.stringify(saved)); } catch { /* Current-session saves remain available. */ } }, [saved]);

  const refresh = useCallback(async () => {
    if (!roleChosen || !user) return;
    const version = ++loadVersion.current;
    const foodParams = new URLSearchParams();
    const charityParams = new URLSearchParams();
    if (search) foodParams.set('q', search);
    if (user.role === 'donor') { foodParams.set('mine', 'true'); foodParams.set('status', 'all'); }
    else {
      if (category !== 'all') foodParams.set('category', category);
      if (area) { foodParams.set('lat', String(area.latitude)); foodParams.set('lng', String(area.longitude)); foodParams.set('radius', String(area.radius)); }
    }
    if (charityQuery) charityParams.set('q', charityQuery);
    if (area) { charityParams.set('lat', String(area.latitude)); charityParams.set('lng', String(area.longitude)); charityParams.set('radius', String(area.radius)); }
    const [food, inbox, directory] = await Promise.all([
      api<{ listings: Listing[] }>(`/listings?${foodParams}`),
      api<{ requests: RequestItem[] }>('/requests'),
      user.role === 'donor' ? api<{ charities: Charity[] }>(`/charities?${charityParams}`) : Promise.resolve({ charities: [] })
    ]);
    if (version !== loadVersion.current) return;
    setListings(food.listings); setRequests(inbox.requests); setCharities(directory.charities);
  }, [user, roleChosen, search, charityQuery, category, area]);
  useEffect(() => {
    if (!roleChosen || !user) return;
    let cancelled = false;
    setLoading(true); setError('');
    refresh().catch(reason => { if (!cancelled) setError(reason.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refresh, roleChosen, user]);

  const isDonor = user?.role === 'donor';
  const switchRole = () => {
    ++loadVersion.current;
    setRoleChosen(false); setModal(null); setToast(''); setEntryError('');
    setListings([]); setCharities([]); setRequests([]);
  };
  async function chooseRole(role: Role) {
    setBusy(true); setEntryError('');
    try {
      const { user: selectedUser } = await post<{ user: User }>('/auth/role', { role });
      setUser(selectedUser); setView('home'); setCategory('all'); setFoodSearch(''); setCharitySearch(''); setRequestTab('all'); setModal(null); setError('');
      setArea(selectedUser.latitude != null && selectedUser.longitude != null ? { label: selectedUser.city, latitude: selectedUser.latitude, longitude: selectedUser.longitude, radius: 10 } : null);
      setRoleChosen(true);
    } catch (reason) { setEntryError((reason as Error).message); }
    finally { setBusy(false); }
  }
  async function logout() {
    try { await post('/auth/logout', {}); setUser(null); switchRole(); }
    catch (reason) { notify((reason as Error).message); }
  }
  function openModal(name: ModalName) { setModalError(''); setModal(name); }
  function openListing(listing: Listing) { setSelected(listing); setMessage(''); setRequestQuantity(listing.quantity); openModal('detail'); }
  function toggleSaved(id: Id) { setSaved(current => current.includes(String(id)) ? current.filter(item => item !== String(id)) : [...current, String(id)]); }
  async function sendRequest(event: FormEvent) {
    event.preventDefault();
    if (!selected || user?.role !== 'charity') return;
    setBusy(true); setModalError('');
    try {
      await post(`/listings/${selected.id}/requests`, { message, quantity: requestQuantity });
      setModal(null); setView('requests'); await refresh(); notify('Your pickup request has been sent.');
    } catch (reason) { setModalError((reason as Error).message); }
    finally { setBusy(false); }
  }
  async function updateRequest(id: Id, status: string) {
    setBusy(true);
    try {
      await patch(`/requests/${id}`, { status }); await refresh();
      notify(status === 'accepted' ? 'Request accepted. You can now arrange the collection.' : status === 'completed' ? 'Collection complete. Thank you for sharing!' : 'Request declined.');
    } catch (reason) { notify((reason as Error).message); }
    finally { setBusy(false); }
  }
  async function collectListing() {
    if (!selected || !isDonor) return;
    setBusy(true);
    try { await patch(`/listings/${selected.id}`, { status: 'collected' }); setModal(null); await refresh(); notify('Donation marked as collected.'); }
    catch (reason) { setModalError((reason as Error).message); }
    finally { setBusy(false); }
  }
  function useLocation() {
    if (!navigator.geolocation) { setModalError('Your browser does not support location sharing. Choose a city instead.'); return; }
    setBusy(true); setModalError('');
    navigator.geolocation.getCurrentPosition(position => {
      setArea({ label: 'Current location', latitude: position.coords.latitude, longitude: position.coords.longitude, radius }); setModal(null); setBusy(false);
    }, () => { setModalError('Location access was unavailable. Choose a city below.'); setBusy(false); }, { timeout: 12000, maximumAge: 300000 });
  }
  const openArea = () => { setCity(area?.label || 'London'); setRadius(area?.radius || 10); openModal('location'); };
  const pendingCount = requests.filter(request => request.status === 'pending').length;
  const filteredRequests = requests.filter(request => requestTab === 'all' || request.status === requestTab);
  const visibleListings = listings.filter(listing => view !== 'saved' || saved.includes(String(listing.id))).slice().sort((a, b) => sort === 'newest' ? Date.parse(b.createdAt) - Date.parse(a.createdAt) : (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  const currentRequest = selected ? requests.find(request => String(request.listing.id) === String(selected.id)) : null;
  const showingDirectory = isDonor && (view === 'home' || view === 'charities');
  const showingFood = isDonor ? view === 'donations' : view === 'home' || view === 'saved';
  const title = view === 'home' ? (isDonor ? 'Overview' : 'Find food') : view === 'donations' ? 'My donations' : view === 'charities' ? 'Nearby charities' : view === 'requests' ? (isDonor ? 'Incoming requests' : 'My requests') : view === 'saved' ? 'Saved food' : 'How it works';

  if (!roleChosen || !user) return <main className="role-page">
    <div className="role-page-inner">
      <div className="role-page-brand"><Brand /></div>
      <h1 className="role-page-title">How will you use MatchFood?</h1>
      <p className="role-page-subtitle">Choose your role to continue.</p>
      <div className="auth-options">
        <button className="role-card role-option" disabled={!ready || busy || !roleAccessEnabled} onClick={() => chooseRole('donor')}>
          <span className="role-icon"><ShoppingBag size={28} /></span>
          <span><strong>I’m a donor</strong><span>I have food to donate.</span></span><ArrowUpRight size={22} />
        </button>
        <button className="role-card role-option" disabled={!ready || busy || !roleAccessEnabled} onClick={() => chooseRole('charity')}>
          <span className="role-icon"><HeartHandshake size={28} /></span>
          <span><strong>I’m a charity</strong><span>I’m looking for food for my community.</span></span><ArrowUpRight size={22} />
        </button>
      </div>
      {entryError && <p className="role-page-error" role="alert">{entryError}</p>}
      {!roleAccessEnabled && <p className="role-page-error" role="alert">Role access is currently unavailable.</p>}
      {busy && <p className="role-page-subtitle" role="status">Getting things ready…</p>}
    </div>
  </main>;

  const locationButton = <button className="location-select" onClick={openArea}><MapPin size={16} /><span>{area ? `${area.label} · ${area.radius} km` : 'All locations'}</span><ChevronDown size={14} /></button>;
  const retry = () => refresh().then(() => setError('')).catch(reason => setError(reason.message));

  return <div className="app-shell">
    <aside className="sidebar">
      <Brand onClick={() => setView('home')} />
      <div className="sidebar-section-label">YOUR COMMUNITY</div>
      <nav className="nav-list" aria-label="Main navigation">
        <button className={`nav-item ${view === 'home' ? 'active' : ''}`} onClick={() => setView('home')}><Compass />{isDonor ? 'Overview' : 'Find food'}</button>
        {isDonor ? <>
          <button className={`nav-item ${view === 'donations' ? 'active' : ''}`} onClick={() => setView('donations')}><Package />My donations<span className="notification-count">{listings.length}</span></button>
          <button className={`nav-item ${view === 'charities' ? 'active' : ''}`} onClick={() => setView('charities')}><HeartHandshake />Nearby charities</button>
        </> : <button className={`nav-item ${view === 'saved' ? 'active' : ''}`} onClick={() => setView('saved')}><Heart />Saved food{saved.length > 0 && <span className="notification-count">{saved.length}</span>}</button>}
        <button className={`nav-item ${view === 'requests' ? 'active' : ''}`} onClick={() => setView('requests')}><MessageCircle />{isDonor ? 'Incoming requests' : 'My requests'}{pendingCount > 0 && <span className="notification-count">{pendingCount}</span>}</button>
        <button className={`nav-item ${view === 'how' ? 'active' : ''}`} onClick={() => setView('how')}><HelpCircle />How it works</button>
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-note"><div className="sidebar-note-icon"><Leaf size={25} /></div><h3>A little surplus.<br />A lot of possibility.</h3><p>Your community can make good food go further.</p><button onClick={() => isDonor ? openModal('create') : setView('home')}>{isDonor ? 'Donate something good' : 'Find food nearby'}<ArrowUpRight size={16} /></button></div>
        <button className="nav-item" onClick={() => openModal('profile')}><Settings />Your organisation</button>
        <div className="sidebar-footer"><span className="status-dot" />Made for a kinder community</div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div className="topbar-title"><span className="desktop-breadcrumb">Your community<ChevronRight size={13} /></span><strong>{title}</strong></div>
        <div className="topbar-actions">
          <button className="role-switch" aria-label="Switch role" title="Switch role" onClick={switchRole}><span className="status-dot" />{isDonor ? 'Donor' : 'Charity'}<ChevronDown size={13} /></button>
          <button className="icon-button notification-button" aria-label="View requests" onClick={() => setView('requests')}><Bell size={20} />{pendingCount > 0 && <span className="notification-dot" />}</button>
          <button className="avatar" aria-label="Edit your profile" onClick={() => openModal('profile')}>{user.name.split(' ').map(part => part[0]).slice(0, 2).join('')}</button>
        </div>
      </header>
      <div className="page-content">
        {view === 'home' && (isDonor ? <>
          <section className="donor-intro"><div><span className="eyebrow">MAKE YOUR SURPLUS MATTER</span><h1>Share good food.<br />Support your community.</h1><p>Tell us what food you’d like to donate, then find charities nearby that can put it to good use.</p></div><div className="hero-actions"><button className="btn primary" onClick={() => openModal('create')}>Donate food<Plus size={18} /></button><button className="btn secondary" onClick={() => setView('donations')}>View my donations<ArrowRight size={16} /></button></div></section>
          <section className="stats-grid" aria-label="Your activity"><div className="stat"><span className="stat-icon"><Package size={21} /></span><div><strong className="stat-value">{listings.filter(listing => listing.status === 'available').length}<span>active donations</span></strong><span className="stat-label">Food you’re ready to share</span></div></div><div className="stat"><span className="stat-icon"><HeartHandshake size={21} /></span><div><strong className="stat-value">{charities.length}<span>nearby charities</span></strong><span className="stat-label">Find a community connection</span></div></div><div className="stat"><span className="stat-icon"><Check size={21} /></span><div><strong className="stat-value">{requests.filter(request => request.status === 'completed').length}<span>collections</span></strong><span className="stat-label">Good food, shared with care</span></div></div></section>
        </> : <section className="hero"><div className="hero-copy"><span className="eyebrow">GOOD FOOD DESERVES A SECOND CHANCE</span><h1>Good food.<br />Better <em>together.</em></h1><p>Find food from local donors and bring something good to your community.</p><div className="hero-actions"><button className="btn primary" onClick={() => document.getElementById('food-feed')?.scrollIntoView({ behavior: 'smooth' })}>Find food nearby<ArrowRight size={17} /></button><button className="hero-text-link" onClick={() => setView('how')}>How it works<ArrowRight size={16} /></button></div></div><div className="hero-art" aria-hidden="true"><img src={foodImage('hero')} alt="" /></div></section>)}

        <section id="food-feed" className={view === 'home' ? 'feed-section' : 'inner-page'}>
          <div className="section-heading"><div>
            <h2>{showingDirectory ? 'Charities near you' : showingFood ? (isDonor ? 'Your food donations' : view === 'saved' ? 'Your saved food' : 'Available in your neighbourhood') : view === 'requests' ? (isDonor ? 'Incoming requests' : 'Your food requests') : 'Small acts. Meaningful change.'}</h2>
            <p>{showingDirectory ? 'Connect with organisations that support your local community.' : showingFood ? (isDonor ? 'Manage the food your organisation has shared.' : 'Find the right donation and send a pickup request.') : view === 'requests' ? (isDonor ? 'Review requests and arrange collections with charities.' : 'Track your requests and connect with donors.') : 'Good food goes further when we share it.'}</p>
          </div>{isDonor && view !== 'home' && <button className="btn primary small" onClick={() => openModal('create')}><Plus size={16} />Donate food</button>}</div>

          {showingDirectory && <>
            <div className="feed-toolbar"><label className="search-field"><Search size={18} /><input aria-label="Search charities" placeholder="Search charities or a town…" value={charitySearch} onChange={event => setCharitySearch(event.target.value)} /></label>{locationButton}</div>
            <div className="results-line"><span>{charities.length} {charities.length === 1 ? 'charity' : 'charities'}{area ? ' near you' : ''}</span><span className="live-indicator"><HeartHandshake size={13} />A connection that makes a difference</span></div>
            {error ? <div className="empty-state"><HelpCircle /><h3>We couldn’t load the charity directory</h3><p>{error}</p><button className="btn secondary" onClick={retry}>Try again</button></div> : loading ? <div className="charities-grid">{[1, 2, 3].map(id => <div key={id} className="loading-skeleton" />)}</div> : charities.length ? <div className="charities-grid">{charities.map(charity => <CharityCard key={charity.id} charity={charity} />)}</div> : <div className="empty-state"><HeartHandshake size={38} /><h3>No charities match this area yet</h3><p>Try a wider search area or a different location.</p><button className="btn secondary" onClick={() => { setCharitySearch(''); setArea(null); }}>Show all charities</button></div>}
          </>}

          {showingFood && <>
            <div className="feed-toolbar"><label className="search-field"><Search size={18} /><input aria-label="Search food or organisations" placeholder={isDonor ? 'Search your donations…' : 'Search food or local donors…'} value={foodSearch} onChange={event => setFoodSearch(event.target.value)} />{foodSearch && <button className="icon-button" aria-label="Clear search" onClick={() => setFoodSearch('')}><X size={15} /></button>}</label>{!isDonor && locationButton}<label className="sort-select"><span className="sr-only">Sort donations</span><select value={sort} onChange={event => setSort(event.target.value)}><option value="nearby">Nearest first</option><option value="newest">Newest first</option></select></label></div>
            {!isDonor && <div className="category-filters" aria-label="Food categories">{CATEGORIES.map(categoryOption => { const Icon = categoryIcons[categoryOption.id]; return <button key={categoryOption.id} className={`chip ${category === categoryOption.id ? 'active' : ''}`} aria-pressed={category === categoryOption.id} onClick={() => setCategory(categoryOption.id)}><Icon size={15} />{categoryOption.label}</button>; })}</div>}
            <div className="results-line"><span>{visibleListings.length} {visibleListings.length === 1 ? 'donation' : 'donations'} {isDonor ? 'shared by you' : view === 'saved' ? 'saved' : 'to discover'}</span></div>
            {error ? <div className="empty-state"><HelpCircle /><h3>We couldn’t load the food feed</h3><p>{error}</p><button className="btn secondary" onClick={retry}>Try again</button></div> : loading ? <div className="listings-grid">{[1, 2, 3].map(id => <div key={id} className="loading-skeleton" />)}</div> : visibleListings.length ? <div className="listings-grid">{visibleListings.map(listing => <FoodCard key={listing.id} listing={listing} saved={saved.includes(String(listing.id))} onSave={isDonor ? undefined : () => toggleSaved(listing.id)} onOpen={() => openListing(listing)} />)}</div> : <div className="empty-state"><ShoppingBag size={38} /><h3>{isDonor ? 'Your first donation starts here' : view === 'saved' ? 'Save something for later' : 'No food matches just yet'}</h3><p>{isDonor ? 'Choose the food and quantity you’d like to share.' : 'Try another category, location, or search.'}</p><button className="btn primary" onClick={() => { if (isDonor) openModal('create'); else { setFoodSearch(''); setCategory('all'); setArea(null); setView('home'); } }}>{isDonor ? 'Share your first donation' : 'Show all food'}<ArrowRight size={16} /></button></div>}
          </>}

          {view === 'requests' && <>
            <div className="tabs" role="group" aria-label="Filter requests">{['all', 'pending', 'accepted', 'completed', 'declined'].map(status => <button key={status} className={`tab ${requestTab === status ? 'active' : ''}`} onClick={() => setRequestTab(status)}>{status[0].toUpperCase() + status.slice(1)}{status === 'all' ? ` (${requests.length})` : ''}</button>)}</div>
            {error && <div className="error-banner" role="alert">{error}</div>}
            <div className="inbox-list">{filteredRequests.map(request => <article key={request.id} className="request-card">
              <div className="request-food-thumb"><img src={foodImage(request.listing.category)} alt="" /></div>
              <div className="request-main"><div className="request-card-heading"><div><span className={`request-status ${request.status}`}>{request.status === 'pending' ? 'Awaiting donor' : request.status === 'accepted' ? 'Ready for pickup' : request.status === 'completed' ? 'Collected' : 'Declined'}</span><h3>{request.listing.title}</h3><p>{isDonor ? request.charity.organization : request.donor.organization} · {quantityLabel(request.quantity, request.listing.unit)}</p></div><span className="request-date">{new Date(request.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span></div>
                <p className="request-message">“{request.message}”</p><div className="pickup-note"><Clock size={14} />{request.listing.pickupWindow}</div>
                {request.contact && <div className="contact-card"><strong><Check size={16} />{isDonor ? 'Charity contact' : 'You’re connected! Arrange a collection.'}</strong><span>{request.contact.name} · {request.contact.organization}</span><a href={`mailto:${request.contact.email}`}><Mail size={14} />{request.contact.email}</a>{request.contact.phone && <a href={`tel:${request.contact.phone}`}>{request.contact.phone}</a>}{request.contact.googleMapsUrl && <a href={request.contact.googleMapsUrl} target="_blank" rel="noreferrer">View on Google Maps<ExternalLink size={13} /></a>}</div>}
                <div className="request-actions">{isDonor && request.status === 'pending' && <><button disabled={busy} className="btn primary small" onClick={() => updateRequest(request.id, 'accepted')}><Check size={15} />Accept request</button><button disabled={busy} className="btn secondary small" onClick={() => updateRequest(request.id, 'declined')}>Decline</button></>}{isDonor && request.status === 'accepted' && <button disabled={busy} className="btn primary small" onClick={() => updateRequest(request.id, 'completed')}><Check size={15} />Mark as collected</button>}{!isDonor && request.status === 'pending' && <span className="field-help">The donor will review your request. Contact details appear here once it’s accepted.</span>}{['accepted', 'completed'].includes(request.status) && <a className="btn secondary small" href={organisationMaps(request.listing.donor)} target="_blank" rel="noreferrer"><MapPin size={14} />Pickup location<ArrowUpRight size={14} /></a>}</div>
              </div>
            </article>)}</div>
            {!loading && !filteredRequests.length && <div className="empty-state"><MessageCircle size={38} /><h3>No requests here yet</h3><p>{isDonor ? 'Charities can request the food you share.' : 'Find a donation and send the donor a pickup request.'}</p><button className="btn primary" onClick={() => setView(isDonor ? 'donations' : 'home')}>{isDonor ? 'View my donations' : 'Find food'}<ArrowRight size={16} /></button></div>}
          </>}

          {view === 'how' && <div className="how-grid">{(isDonor ? [
            { Icon: Package, title: 'Choose what to donate', body: 'Add the food type, quantity, collection window, and any details a charity needs to know.' },
            { Icon: MapPin, title: 'Find charities near you', body: 'Set your location and connect with organisations serving your local community.' },
            { Icon: HeartHandshake, title: 'Arrange the collection', body: 'Review incoming requests, accept a charity, and coordinate a collection directly.' }
          ] : [
            { Icon: Search, title: 'Find the right food', body: 'Browse food from nearby donors and filter by food type or location.' },
            { Icon: MessageCircle, title: 'Send a pickup request', body: 'Tell the donor how much food you need and when you can collect it.' },
            { Icon: HeartHandshake, title: 'Connect and collect', body: 'Once accepted, use the donor’s contact details and location to arrange pickup.' }
          ]).map(({ Icon, title: stepTitle, body }, index) => <article key={stepTitle} className="how-card"><span className="eyebrow">STEP 0{index + 1}</span><Icon size={32} /><h3>{stepTitle}</h3><p>{body}</p></article>)}</div>}
        </section>
        <footer className="footer-note"><span><Sprout size={16} />Every donation is a fresh start.</span><button onClick={() => setView('how')}>Made to make a difference<Heart size={12} /></button></footer>
      </div>
    </main>

    {toast && <div className="toast" role="status"><Check size={18} />{toast}<button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast('')}><X size={15} /></button></div>}
    {modal === 'profile' && <Dialog title="Your organisation" onClose={() => setModal(null)} wide><ProfileForm user={user} onCancel={() => setModal(null)} onSaved={updated => { setUser(updated); setArea(updated.latitude != null && updated.longitude != null ? { label: updated.city, latitude: updated.latitude, longitude: updated.longitude, radius: 10 } : null); setModal(null); notify('Your organisation profile is up to date.'); }} /><div className="profile-signout"><span>{isDonor ? 'Donor' : 'Charity'} profile</span><button className="btn ghost small" onClick={logout}><LogOut size={15} />Sign out</button></div></Dialog>}
    {modal === 'create' && isDonor && <Dialog title="Donate food" onClose={() => setModal(null)} wide><p className="field-help form-intro">Choose the food and quantity you want to share.</p><ListingForm onCancel={() => setModal(null)} onSaved={() => { setModal(null); setView('charities'); refresh().catch(reason => notify(reason.message)); notify('Your donation is shared. Find a charity nearby to connect with.'); }} /></Dialog>}
    {modal === 'location' && <Dialog title={isDonor ? 'Find charities near you' : 'Good food, closer to you'} onClose={() => setModal(null)}><p className="form-intro">Choose a city or use your current location.</p><button disabled={busy} className="btn secondary location-current" onClick={useLocation}><Navigation size={17} />{busy ? 'Finding your location…' : 'Use my current location'}</button><form onSubmit={event => { event.preventDefault(); const location = CITIES.find(option => option.label === city); if (location) { setArea({ ...location, radius }); setModal(null); } else setModalError('Choose a city from the list.'); }}><div className="form-grid"><label className="field full">City<select className="input" value={city} onChange={event => setCity(event.target.value)}>{!CITIES.some(option => option.label === city) && <option value={city}>{city}</option>}{CITIES.map(option => <option key={option.label}>{option.label}</option>)}</select></label><label className="field full">Search within<select className="input" value={radius} onChange={event => setRadius(Number(event.target.value))}>{[2, 5, 10, 25, 50, 100].map(distance => <option key={distance} value={distance}>{distance} km</option>)}</select></label></div>{modalError && <p className="error-banner" role="alert">{modalError}</p>}<div className="modal-footer"><button type="button" className="btn ghost" onClick={() => { setArea(null); setModal(null); }}>All locations</button><button className="btn primary" disabled={busy}>{isDonor ? 'Find nearby charities' : 'Find food nearby'}<ArrowRight size={16} /></button></div></form></Dialog>}
    {modal === 'detail' && selected && <Dialog title={isDonor ? 'Your donation' : 'A little extra, a big difference'} onClose={() => setModal(null)} wide>
      <div className="detail-image"><img src={foodImage(selected.category)} alt={selected.title} /><span className="food-badge"><span className="status-dot" />{selected.status === 'available' ? 'Available to collect' : selected.status}</span></div>
      <div className="detail-layout"><div><span className="food-category">{categoryLabels[selected.category]}</span><h2 className="detail-title">{selected.title}</h2><p className="detail-description">{selected.description}</p><div className="detail-section"><h3><Package size={17} />What’s available</h3><strong>{quantityLabel(selected.quantity, selected.unit)}</strong><div className="tag-list">{selected.allergens.length ? selected.allergens.map(allergen => <span key={allergen} className="tag">Contains {allergen}</span>) : <span className="field-help">Check allergen details with the donor.</span>}</div></div><div className="detail-section"><h3><Clock size={17} />Collection</h3><p>{selected.pickupWindow}</p><p className="field-help">Available until {deadlineLabel(selected.availableUntil)}</p></div></div><aside className="donor-info"><span className="eyebrow">SHARED WITH CARE BY</span><h3>{selected.donor.organization}</h3><span className="verified"><ShieldCheck size={14} />{selected.donor.businessType || 'Community donor'}</span><p><MapPin size={15} />{selected.donor.address}, {selected.donor.city}</p><a className="btn secondary small" href={organisationMaps(selected.donor)} target="_blank" rel="noreferrer">View on Google Maps<ExternalLink size={14} /></a></aside></div>
      {modalError && <div className="error-banner" role="alert">{modalError}</div>}
      {isDonor ? <div className="modal-footer"><button className="btn secondary" onClick={() => { setModal(null); setView('charities'); }}>Find nearby charities<HeartHandshake size={16} /></button>{selected.status !== 'collected' && <button className="btn primary" disabled={busy} onClick={collectListing}>Mark as collected<Check size={16} /></button>}</div> : currentRequest && currentRequest.status !== 'declined' ? <div className="notice"><Check size={18} /><span>Your request is <strong>{currentRequest.status}</strong>.</span><button className="btn secondary small" onClick={() => { setModal(null); setView('requests'); }}>View request</button></div> : selected.status === 'available' ? <form className="request-form" onSubmit={sendRequest}><h3>Let’s make a connection</h3><p className="field-help">Tell the donor when you can collect and how much food you need.</p><div className="form-grid"><label className="field">Quantity to request<input className="input" type="number" min="0.01" step="any" max={selected.quantity} required value={requestQuantity} onChange={event => setRequestQuantity(Number(event.target.value))} /><span className="field-help">Up to {quantityLabel(selected.quantity, selected.unit)}</span></label><label className="field full">Your message<textarea className="input" rows={3} minLength={10} maxLength={1500} required placeholder="Hi! We’d love to collect this for our community kitchen…" value={message} onChange={event => setMessage(event.target.value)} /></label></div><div className="modal-footer"><span className="field-help">Contact details are shared once accepted.</span><button className="btn primary" disabled={busy}>{busy ? 'Sending…' : 'Send pickup request'}<ArrowUpRight size={17} /></button></div></form> : <div className="notice">This donation has already been {selected.status}.</div>}
    </Dialog>}
  </div>;
}
