'use strict';
// Day keys and leaderboard participant ids for the daily, per-room board.
//
// A "day" is the integer number of whole days since 1970-01-01 in Asia/Ho_Chi_Minh
// (UTC+7, no daylight saving), so it flips at 00:00 Vietnam time. It is derived from
// a millisecond clock handed in by the caller; gameplay never waits for a "reset job".

const { createHmac, randomUUID } = require('crypto');

const VN_OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 86400000;

const dayOf = (ms) => Math.floor((ms + VN_OFFSET_MS) / DAY_MS);
// 'YYYY-MM-DD' of a day number (the same digits Postgres `date` uses for the SQL rows).
const dayDate = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
// Milliseconds until the next 00:00 Vietnam time.
const msToNextDay = (ms) => (dayOf(ms) + 1) * DAY_MS - VN_OFFSET_MS - ms;

// Participant ids. They are server-internal: never sent to clients, and unrelated to
// the Redis player id (a small integer that is recycled when a room expires) and to
// the character UUID's role as a profile key.
//   c:<character uuid>   a signed-in character
//   g:<hmac>             a guest tab token (the token itself is never stored)
//   b:<uuid>             a bot; random, not derivable from anything a client knows
const characterActor = (characterId) => 'c:' + characterId;
const botActor = () => 'b:' + randomUUID();
function guestActor(room, token, secret = process.env.AUTH_SECRET || 'break-room-guest') {
  return 'g:' + createHmac('sha256', secret).update(room + '|' + token).digest('hex').slice(0, 40);
}

// Score is stored in tenths of a point: costs and boss shares are multiples of 0.1.
const toTenths = (n) => Math.round(Number(n) * 10);
const fromTenths = (t) => Number(t) / 10;

module.exports = { VN_OFFSET_MS, DAY_MS, dayOf, dayDate, msToNextDay, characterActor, botActor, guestActor, toTenths, fromTenths };
