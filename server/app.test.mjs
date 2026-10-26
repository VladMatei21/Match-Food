import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './app.mjs';

async function fixture(t, enableRoleAccess = true) {
  const dataDir = await mkdtemp(path.join(tmpdir(),'match-food-api-'));
  const instance = createApp({dataDir,enableRoleAccess,serveStatic:false});
  const server = instance.app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    instance.close();
    await rm(dataDir,{recursive:true,force:true});
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url,{method='GET',body,cookie,origin}={}) => {
    const response = await fetch(base+url,{method,headers:{...(body ? {'Content-Type':'application/json'} : {}),...(cookie ? {Cookie:cookie} : {}),...(origin ? {Origin:origin} : {})},body:body ? JSON.stringify(body) : undefined});
    const result = await response.json();
    return {status:response.status,body:result,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  };
  const chooseRole = async role => {
    const response = await request('/api/auth/role',{method:'POST',body:{role}});
    assert.equal(response.status,200);
    return response;
  };
  return {...instance,request,chooseRole,dataDir};
}

const profile = (role,email) => ({role,email,password:'StrongPassword123!',name:role === 'donor' ? 'Donor Person' : 'Charity Person',organization:`${role} organization`,businessType:role === 'donor' ? 'Restaurant' : 'Community charity',address:'10 High Street',city:'London',latitude:51.503,longitude:-0.09,phone:'+44 1234567890',googleMapsUrl:'https://www.google.com/maps/search/?api=1&query=London'});
const food = () => ({title:'Fresh vegetable soup',category:'prepared',quantity:12,unit:'portions',description:'Freshly cooked vegetarian soup, safely chilled and ready for collection.',allergens:['celery'],availableUntil:new Date(Date.now()+86400000).toISOString(),pickupWindow:'Today, 4 PM – 6 PM'});

test('role choice creates persistent sessions and charities can filter available food',async t=>{
  const {request,chooseRole} = await fixture(t);
  const health = await request('/api/health');
  assert.deepEqual(health.body,{ok:true,roleAccessEnabled:true});
  assert.equal((await request('/api/stats')).status,401);
  assert.equal((await request('/api/auth/role',{method:'POST',body:{role:'admin'}})).status,400);
  const donor = await chooseRole('donor');
  assert.equal(donor.body.user.role,'donor');
  assert.equal(donor.body.user.email,'donor@matchfood.example');
  assert.match(donor.headers.get('set-cookie'),/HttpOnly/);
  assert.match(donor.headers.get('set-cookie'),/SameSite=Lax/);
  assert.equal((await request('/api/me',{cookie:donor.cookie})).body.user.id,donor.body.user.id);
  assert.equal((await request('/api/me',{cookie:donor.cookie})).body.roleAccessEnabled,true);
  const charity = await chooseRole('charity');
  assert.equal((await request('/api/me',{cookie:charity.cookie})).body.user.role,'charity');
  assert.equal((await request('/api/listings')).status,401);
  const listings = await request('/api/listings?lat=51.5034&lng=-0.0951&radius=2',{cookie:charity.cookie});
  assert.equal(listings.status,200);
  assert.equal(listings.body.listings.length,6);
  for (const listing of listings.body.listings) {
    assert.equal(typeof listing.distanceKm,'number');
    assert.equal(listing.donor.email,undefined);
    assert.equal(listing.donor.phone,undefined);
    assert.equal(listing.donor.passwordHash,undefined);
    assert.ok(listing.distanceKm<=2);
  }
  const bakery = await request('/api/listings?category=bakery&q=sourdough',{cookie:charity.cookie});
  assert.equal(bakery.body.listings.length,1);
  assert.equal(bakery.body.listings[0].category,'bakery');
  assert.equal((await request('/api/listings?lat=40&lng=-70&radius=2',{cookie:charity.cookie})).body.listings.length,0);
  assert.equal((await request('/api/listings?lat=51.5&radius=10',{cookie:charity.cookie})).status,400);
  assert.equal((await request('/api/listings?lat=51.5&lng=-0.1&radius=-2',{cookie:charity.cookie})).status,400);
  assert.equal((await request('/api/listings?mine=true')).status,401);
  const mine = await request('/api/listings?mine=true',{cookie:donor.cookie});
  assert.equal(mine.body.listings.length,2);
  assert.ok(mine.body.listings.every(item=>item.donorId===donor.body.user.id));
  for (const query of ['', '?mine=false', '?mine=false&status=all&donorId=other', '?mine=true&role=charity']) {
    const ownOnly = await request(`/api/listings${query}`,{cookie:donor.cookie});
    assert.equal(ownOnly.status,200);
    assert.equal(ownOnly.body.listings.length,2);
    assert.ok(ownOnly.body.listings.every(item=>item.donorId===donor.body.user.id));
  }
  assert.equal((await request('/api/auth/logout',{method:'POST',cookie:charity.cookie})).status,200);
  assert.equal((await request('/api/me',{cookie:charity.cookie})).body.user,null);
});

test('only donors can find and contact nearby charities with real radius and text filters',async t=>{
  const {request,chooseRole} = await fixture(t);
  assert.equal((await request('/api/charities')).status,401);
  const donor = await chooseRole('donor');
  const charity = await chooseRole('charity');
  assert.equal((await request('/api/charities',{cookie:charity.cookie})).status,403);
  const nearby = await request('/api/charities',{cookie:donor.cookie});
  assert.equal(nearby.status,200);
  assert.equal(nearby.body.charities.length,3);
  for (const organization of nearby.body.charities) {
    assert.equal(organization.role,'charity');
    assert.equal(typeof organization.distanceKm,'number');
    assert.ok(organization.distanceKm>=0);
    assert.equal(typeof organization.email,'string');
    assert.equal(typeof organization.phone,'string');
    assert.equal(organization.passwordHash,undefined);
  }
  const distances=nearby.body.charities.map(row=>row.distanceKm);
  assert.deepEqual(distances,[...distances].sort((a,b)=>a-b));
  const results = await request('/api/charities?q=Southbank',{cookie:donor.cookie});
  assert.equal(results.body.charities.length,1);
  assert.equal(results.body.charities[0].organization,'Southbank Community Pantry');
  const distant = await request('/api/charities?lat=40&lng=-70&radius=1',{cookie:donor.cookie});
  assert.equal(distant.body.charities.length,0);
  const local = await request('/api/charities?lat=51.5055&lng=-0.0909&radius=1',{cookie:donor.cookie});
  assert.ok(local.body.charities.length>0);
  assert.ok(local.body.charities.every(row=>row.distanceKm<=1));
  assert.equal((await request('/api/charities?lat=91&lng=0',{cookie:donor.cookie})).status,400);
  assert.equal((await request('/api/charities?lat=51&radius=2',{cookie:donor.cookie})).status,400);
  assert.equal((await request('/api/charities?radius=-1',{cookie:donor.cookie})).status,400);
});

test('registration, login, profile validation and role permissions protect persisted accounts',async t=>{
  const {request,db} = await fixture(t,false);
  assert.equal((await request('/api/auth/role',{method:'POST',body:{role:'donor'}})).status,404);
  const donor = await request('/api/auth/register',{method:'POST',body:profile('donor','donor@example.org')});
  assert.equal(donor.status,201);
  assert.equal(donor.body.user.passwordHash,undefined);
  const stored = db.prepare('SELECT passwordHash FROM users WHERE id=?').get(donor.body.user.id);
  assert.notEqual(stored.passwordHash,'StrongPassword123!');
  assert.equal((await request('/api/auth/register',{method:'POST',body:profile('donor','donor@example.org')})).status,409);
  assert.equal((await request('/api/auth/register',{method:'POST',body:profile('admin','admin@example.org')})).status,400);
  assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'donor@example.org',password:'bad-password'}})).status,401);
  const login = await request('/api/auth/login',{method:'POST',body:{email:'DONOR@example.org',password:'StrongPassword123!'}});
  assert.equal(login.status,200);
  const charity = await request('/api/auth/register',{method:'POST',body:profile('charity','charity@example.org')});
  assert.equal(charity.status,201);
  assert.equal((await request('/api/listings',{method:'POST',body:food(),cookie:charity.cookie})).status,403);
  assert.equal((await request('/api/listings',{method:'POST',body:food()})).status,401);
  const badMap = await request('/api/profile',{method:'PATCH',cookie:donor.cookie,body:{googleMapsUrl:'https://attacker.example/maps'}});
  assert.equal(badMap.status,400);
  assert.equal((await request('/api/profile',{method:'PATCH',cookie:donor.cookie,body:{latitude:900}})).status,400);
  const profileUpdate = await request('/api/profile',{method:'PATCH',cookie:donor.cookie,body:{organization:'New Community Kitchen',googleMapsUrl:'https://maps.app.goo.gl/example'}});
  assert.equal(profileUpdate.status,200);
  assert.equal(profileUpdate.body.user.organization,'New Community Kitchen');
  assert.equal(profileUpdate.body.user.role,'donor');
  assert.equal((await request('/api/profile',{method:'PATCH',cookie:donor.cookie,origin:'https://attacker.example',body:{name:'Attacker'}})).status,403);
  assert.equal((await request('/api/listings',{method:'POST',cookie:donor.cookie,body:{...food(),quantity:-1}})).status,400);
  assert.equal((await request('/api/listings',{method:'POST',cookie:donor.cookie,body:{...food(),availableUntil:'2020-01-01'}})).status,400);
});

test('charity request to donor acceptance releases contact and collection updates listings and impact',async t=>{
  const {request,chooseRole} = await fixture(t);
  const donor = await chooseRole('donor');
  const charity = await chooseRole('charity');
  const created = await request('/api/listings',{method:'POST',cookie:donor.cookie,body:food()});
  assert.equal(created.status,201);
  const listingId = created.body.listing.id;
  assert.equal((await request(`/api/listings/${listingId}/requests`,{method:'POST',cookie:donor.cookie,body:{message:'We can collect today.'}})).status,403);
  assert.equal((await request(`/api/listings/${listingId}/requests`,{method:'POST',cookie:charity.cookie,body:{message:'We can collect today.',quantity:30}})).status,400);
  const requested = await request(`/api/listings/${listingId}/requests`,{method:'POST',cookie:charity.cookie,body:{message:'We can collect today for our community dinner.',quantity:12}});
  assert.equal(requested.status,201);
  assert.equal(requested.body.request.status,'pending');
  assert.equal(requested.body.request.contact,null);
  assert.equal(requested.body.request.donor.email,undefined);
  assert.equal(requested.body.request.listing.donor.phone,undefined);
  const requestId = requested.body.request.id;
  assert.equal((await request(`/api/listings/${listingId}/requests`,{method:'POST',cookie:charity.cookie,body:{message:'Another request today.'}})).status,409);
  assert.equal((await request(`/api/requests/${requestId}`,{method:'PATCH',cookie:charity.cookie,body:{status:'accepted'}})).status,403);
  const donorRequests = await request('/api/requests',{cookie:donor.cookie});
  assert.equal(donorRequests.body.requests[0].contact.email,'charity@matchfood.example');
  const accepted = await request(`/api/requests/${requestId}`,{method:'PATCH',cookie:donor.cookie,body:{status:'accepted'}});
  assert.equal(accepted.status,200);
  assert.equal(accepted.body.request.status,'accepted');
  assert.equal(accepted.body.request.listing.status,'reserved');
  const charityRequests = await request('/api/requests',{cookie:charity.cookie});
  assert.equal(charityRequests.body.requests[0].contact.email,'donor@matchfood.example');
  assert.equal((await request('/api/listings',{cookie:charity.cookie})).body.listings.some(item=>item.id===listingId),false);
  const completed = await request(`/api/requests/${requestId}`,{method:'PATCH',cookie:donor.cookie,body:{status:'completed'}});
  assert.equal(completed.status,200);
  assert.equal(completed.body.request.listing.status,'collected');
  const stats = await request('/api/stats',{cookie:charity.cookie});
  assert.equal(stats.body.mealsShared,12);
  assert.equal(stats.body.foodSavedKg,4.8);
  assert.equal((await request(`/api/requests/${requestId}`,{method:'PATCH',cookie:donor.cookie,body:{status:'completed'}})).status,409);
});

test('request ownership and competing charity requests prevent duplicate reservations',async t=>{
  const {request,chooseRole} = await fixture(t);
  const donor = await chooseRole('donor');
  const charity = await chooseRole('charity');
  const otherCharity = await request('/api/auth/register',{method:'POST',body:profile('charity','other-charity@example.org')});
  const otherDonor = await request('/api/auth/register',{method:'POST',body:profile('donor','other-donor@example.org')});
  const created = await request('/api/listings',{method:'POST',cookie:donor.cookie,body:food()});
  const id = created.body.listing.id;
  const r1 = await request(`/api/listings/${id}/requests`,{method:'POST',cookie:charity.cookie,body:{message:'We can collect the soup.'}});
  const r2 = await request(`/api/listings/${id}/requests`,{method:'POST',cookie:otherCharity.cookie,body:{message:'We can collect the soup as well.'}});
  assert.equal((await request(`/api/listings/${id}`,{method:'PATCH',cookie:otherDonor.cookie,body:{status:'collected'}})).status,403);
  assert.equal((await request(`/api/requests/${r1.body.request.id}`,{method:'PATCH',cookie:otherDonor.cookie,body:{status:'accepted'}})).status,403);
  assert.equal((await request('/api/requests',{cookie:otherDonor.cookie})).body.requests.length,0);
  assert.equal((await request('/api/requests',{cookie:otherCharity.cookie})).body.requests.length,1);
  assert.equal((await request(`/api/requests/${r1.body.request.id}`,{method:'PATCH',cookie:donor.cookie,body:{status:'accepted'}})).status,200);
  assert.equal((await request(`/api/requests/${r2.body.request.id}`,{method:'PATCH',cookie:donor.cookie,body:{status:'accepted'}})).status,409);
  assert.equal((await request('/api/requests',{cookie:otherCharity.cookie})).body.requests[0].status,'declined');
});

test('sample food remains usable after an expired retained snapshot without reopening collected food',async t=>{
  const {db,dataDir} = await fixture(t);
  db.prepare("UPDATE listings SET availableUntil='2020-01-01T00:00:00.000Z' WHERE id='demo-bakery'").run();
  db.prepare("UPDATE listings SET status='collected', availableUntil='2020-01-01T00:00:00.000Z' WHERE id='demo-fruit'").run();
  const second = createApp({dataDir,enableRoleAccess:true,serveStatic:false});
  t.after(()=>second.close());
  assert.ok(second.db.prepare("SELECT availableUntil FROM listings WHERE id='demo-bakery'").get().availableUntil>new Date().toISOString());
  assert.equal(second.db.prepare("SELECT status FROM listings WHERE id='demo-fruit'").get().status,'collected');
});

test('legacy seed emails migrate without changing identities, profiles, sessions, listings or requests',async t=>{
  const {request,chooseRole,db,dataDir} = await fixture(t);
  const donor = await chooseRole('donor');
  const charity = await chooseRole('charity');
  await request('/api/profile',{method:'PATCH',cookie:donor.cookie,body:{organization:'Preserved Donor Profile'}});
  const created = await request('/api/listings',{method:'POST',cookie:donor.cookie,body:food()});
  const requested = await request(`/api/listings/${created.body.listing.id}/requests`,{method:'POST',cookie:charity.cookie,body:{message:'Please keep this request across the migration.'}});
  assert.equal(requested.status,201);
  const names=['donor','produce','kitchen','charity'];
  const userIds=new Map(names.map(name=>[name,db.prepare('SELECT id FROM users WHERE email=?').get(`${name}@matchfood.example`).id]));
  for (const name of names) db.prepare('UPDATE users SET email=? WHERE id=?').run(`${name}@matchfood.demo`,userIds.get(name));
  const listingIds=db.prepare('SELECT id FROM listings ORDER BY id').all().map(row=>row.id);
  const requestBefore=db.prepare('SELECT * FROM requests WHERE id=?').get(requested.body.request.id);
  const sessionsBefore=db.prepare('SELECT * FROM sessions ORDER BY tokenHash').all();
  const usersBefore=db.prepare('SELECT count(*) AS n FROM users').get().n;
  const second=createApp({dataDir,enableRoleAccess:true,serveStatic:false});
  t.after(()=>second.close());
  for (const name of names) {
    assert.equal(second.db.prepare('SELECT id FROM users WHERE email=?').get(`${name}@matchfood.example`).id,userIds.get(name));
    assert.equal(second.db.prepare('SELECT id FROM users WHERE email=?').get(`${name}@matchfood.demo`),undefined);
  }
  assert.equal(second.db.prepare('SELECT count(*) AS n FROM users').get().n,usersBefore);
  assert.equal(second.db.prepare('SELECT organization FROM users WHERE id=?').get(donor.body.user.id).organization,'Preserved Donor Profile');
  assert.deepEqual(second.db.prepare('SELECT id FROM listings ORDER BY id').all().map(row=>row.id),listingIds);
  assert.deepEqual(second.db.prepare('SELECT * FROM requests WHERE id=?').get(requested.body.request.id),requestBefore);
  assert.deepEqual(second.db.prepare('SELECT * FROM sessions ORDER BY tokenHash').all(),sessionsBefore);
  const me=await request('/api/me',{cookie:donor.cookie});
  assert.equal(me.body.user.id,donor.body.user.id);
  assert.equal(me.body.user.email,'donor@matchfood.example');
});

test('an existing canonical email is never overwritten by legacy email migration',async t=>{
  const {request,chooseRole,db,dataDir} = await fixture(t);
  const donor=await chooseRole('donor');
  db.prepare('UPDATE users SET email=? WHERE id=?').run('donor@matchfood.demo',donor.body.user.id);
  const other=await request('/api/auth/register',{method:'POST',body:{...profile('donor','donor@matchfood.example'),organization:'Existing Account'}});
  assert.equal(other.status,201);
  const beforeLegacy=db.prepare('SELECT * FROM users WHERE id=?').get(donor.body.user.id);
  const beforeExisting=db.prepare('SELECT * FROM users WHERE id=?').get(other.body.user.id);
  const second=createApp({dataDir,enableRoleAccess:true,serveStatic:false});
  t.after(()=>second.close());
  assert.deepEqual(second.db.prepare('SELECT * FROM users WHERE id=?').get(donor.body.user.id),beforeLegacy);
  assert.deepEqual(second.db.prepare('SELECT * FROM users WHERE id=?').get(other.body.user.id),beforeExisting);
});
