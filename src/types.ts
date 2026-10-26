export type Id = number | string;
export type Role = 'donor' | 'charity';
export interface User {
  id: Id;
  role: Role;
  name: string;
  email: string;
  organization: string;
  businessType: string;
  phone: string;
  address: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
  googleMapsUrl: string;
}
export interface Listing {
  id: Id;
  donorId: Id;
  title: string;
  category: string;
  quantity: number;
  unit: string;
  description: string;
  allergens: string[];
  availableUntil: string;
  pickupWindow: string;
  status: 'available' | 'reserved' | 'collected';
  image?: string;
  createdAt: string;
  latitude: number | null;
  longitude: number | null;
  distanceKm?: number | null;
  donor: User;
}
export interface RequestItem {
  id: Id;
  status: 'pending' | 'accepted' | 'declined' | 'completed';
  message: string;
  quantity: number;
  createdAt: string;
  updatedAt: string;
  listing: Listing;
  donor: User;
  charity: User;
  contact: Pick<User, 'name' | 'organization' | 'email' | 'phone' | 'googleMapsUrl'> | null;
}
export interface Area { label: string; latitude: number; longitude: number; radius: number }
export interface Charity extends User { distanceKm: number | null }
export const CITIES = [
  { label: 'London', latitude: 51.5074, longitude: -0.1278 },
  { label: 'Manchester', latitude: 53.4808, longitude: -2.2426 },
  { label: 'Birmingham', latitude: 52.4862, longitude: -1.8904 },
  { label: 'Bristol', latitude: 51.4545, longitude: -2.5879 },
  { label: 'Bucharest', latitude: 44.4268, longitude: 26.1025 },
  { label: 'Cluj-Napoca', latitude: 46.7712, longitude: 23.6236 }
];
export const CATEGORIES = [
  { id: 'all', label: 'All food' },
  { id: 'vegetables', label: 'Vegetables' },
  { id: 'fruit', label: 'Fruit' },
  { id: 'bakery', label: 'Bakery' },
  { id: 'prepared', label: 'Prepared meals' },
  { id: 'dairy', label: 'Dairy' },
  { id: 'pantry', label: 'Pantry' }
];
