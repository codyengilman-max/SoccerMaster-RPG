export const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 256;
export const number = (v: unknown, lo = 0, hi = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
export const integer = (v: unknown, lo = 0, hi = Number.MAX_SAFE_INTEGER): v is number => number(v,lo,hi) && Number.isSafeInteger(v);
export const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 10000 && v.every(text);
export const scalar = (v: unknown): boolean => typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
export function jsonData(v: unknown, depth = 0): boolean {
 if (depth > 64) return false;
 if (v === null || scalar(v)) return true;
 if (Array.isArray(v)) return v.length <= 100000 && v.every(x=>jsonData(x,depth+1));
 return object(v) && Object.entries(v).every(([k,x])=> !['__proto__','constructor','prototype'].includes(k) && jsonData(x,depth+1));
}
