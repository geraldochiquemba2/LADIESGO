// Fase 2 — Redis GEO helpers + scripts Lua atómicos
// Usa UpstashRedis (src/upstash.ts). Nenhuma dependência externa.
export const GEO_UPDATE = `
redis.replicate_commands()
redis.call('GEOADD', KEYS[1], ARGV[2], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
redis.call('PEXPIRE', KEYS[2], ARGV[5])
if ARGV[6] then redis.call('SET', KEYS[3], ARGV[6], 'PX', ARGV[5]) end
return 1
`;
export const GEO_QUERY = `
local cutoff = tonumber(ARGV[5]) - tonumber(ARGV[6])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
local res = redis.call('GEORADIUS', KEYS[1], ARGV[1], ARGV[2], ARGV[3], 'km', 'WITHDIST', 'WITHCOORD', 'COUNT', ARGV[4], 'ASC')
local out = {}
for i = 1, #res do
  local m = res[i][1]; local dist = res[i][2]; local coord = res[i][3];
  local s = redis.call('ZSCORE', KEYS[2], m)
  if s and tonumber(s) >= cutoff then out[#out+1] = { m, dist, coord[1], coord[2], s } end
end
return out
`;
export const GEO_DEL = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return redis.call('DEL', KEYS[3])
`;

export const GEO_KEY = 'ladiesgo:geo';
export const GEO_SEEN_KEY = 'ladiesgo:geo:seen';
export const GEO_TTL_MS = 30_000;
