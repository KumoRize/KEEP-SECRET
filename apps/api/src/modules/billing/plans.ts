import type { Modality } from '../providers/types.js';

export type PlanId = 'free' | 'starter' | 'creator' | 'pro' | 'studio';

export interface Plan {
  id: PlanId;
  name: string;
  priceInr: number;
  monthlyCredits: number;
  modalities: Modality[];
  dailyGenerations: number;
  maxConcurrent: number;
  maxVideoSeconds: number;
  maxMusicSeconds: number;
  commercialUse: boolean;
  storageGb: number;
}

const ALL: Modality[] = ['image', 'video', '3d', 'website', 'app', 'game', 'music'];

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free', name: 'Free', priceInr: 0, monthlyCredits: 60,
    modalities: ['image', 'website', 'music'], dailyGenerations: 10, maxConcurrent: 1,
    maxVideoSeconds: 0, maxMusicSeconds: 30, commercialUse: false, storageGb: 1,
  },
  starter: {
    id: 'starter', name: 'Starter', priceInr: 199, monthlyCredits: 600,
    modalities: ['image', 'website', 'app', 'game', 'music', '3d', 'video'], dailyGenerations: 100, maxConcurrent: 2,
    maxVideoSeconds: 5, maxMusicSeconds: 60, commercialUse: true, storageGb: 10,
  },
  creator: {
    id: 'creator', name: 'Creator', priceInr: 499, monthlyCredits: 1700,
    modalities: ALL, dailyGenerations: 300, maxConcurrent: 3,
    maxVideoSeconds: 10, maxMusicSeconds: 120, commercialUse: true, storageGb: 50,
  },
  pro: {
    id: 'pro', name: 'Pro', priceInr: 999, monthlyCredits: 3600,
    modalities: ALL, dailyGenerations: 1000, maxConcurrent: 5,
    maxVideoSeconds: 10, maxMusicSeconds: 180, commercialUse: true, storageGb: 200,
  },
  studio: {
    id: 'studio', name: 'Studio', priceInr: 1999, monthlyCredits: 7600,
    modalities: ALL, dailyGenerations: 3000, maxConcurrent: 10,
    maxVideoSeconds: 10, maxMusicSeconds: 300, commercialUse: true, storageGb: 1000,
  },
};

export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  priceInr: number;
}

/** One-off packs never expire; priced slightly above subscriptions per credit. */
export const CREDIT_PACKS: CreditPack[] = [
  { id: 'pack_500', name: '500 credits', credits: 500, priceInr: 199 },
  { id: 'pack_1500', name: '1,500 credits', credits: 1500, priceInr: 499 },
  { id: 'pack_3500', name: '3,500 credits', credits: 3500, priceInr: 999 },
];

export function getPlan(id: string): Plan {
  return PLANS[id as PlanId] ?? PLANS.free;
}

export const isPlanId = (id: string): id is PlanId => id in PLANS;
