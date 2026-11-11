const Reservation = require('../models/Reservation');
const { ACTIVE_STATUSES } = Reservation;

const DAY = 86400000;

/** Today's local date as a UTC-midnight Date (matches how <input type="date"> values are stored). */
function today() {
  return new Date(new Date().toLocaleDateString('en-CA')); // en-CA => YYYY-MM-DD
}

/**
 * Which bookings hold units during [start, end].
 * A released item that is past its return date (overdue) is still physically with the borrower,
 * so it keeps holding its units on every day until it is marked Returned.
 */
function holdingMatch(start, end) {
  return {
    status: { $in: ACTIVE_STATUSES },
    startDate: { $lte: end },
    $or: [{ endDate: { $gte: start } }, { status: 'Released' }],
  };
}

/** Does booking r hold its units on day d? (same rule as holdingMatch) */
function holdsOn(r, d) {
  return r.startDate <= d && (r.endDate >= d || r.status === 'Released');
}

/** Units of an equipment item already held in the given date range (peak is not computed; all overlapping bookings are summed). */
async function reservedUnits(equipmentId, start, end, excludeId = null) {
  const match = { equipment: equipmentId, ...holdingMatch(start, end) };
  if (excludeId) match._id = { $ne: excludeId };
  const rows = await Reservation.find(match).select('quantity');
  return rows.reduce((sum, r) => sum + r.quantity, 0);
}

/** Units of each equipment item held today (booked for today, out, or overdue). */
async function reservedTodayMap() {
  const t = today();
  const rows = await Reservation.aggregate([
    { $match: holdingMatch(t, t) },
    { $group: { _id: '$equipment', total: { $sum: '$quantity' } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.total]));
}

/** Day-by-day availability of one item for the next `days` days. */
async function availabilityCalendar(equipment, days = 14) {
  const start = today();
  const end = new Date(start.getTime() + (days - 1) * DAY);
  const rows = await Reservation.find({ equipment: equipment._id, ...holdingMatch(start, end) }).select('quantity startDate endDate status');
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start.getTime() + i * DAY);
    const used = rows.filter((r) => holdsOn(r, d)).reduce((s, r) => s + r.quantity, 0);
    return { date: d, used, available: Math.max(0, equipment.quantity - used) };
  });
}

/** Escape user input for use inside a RegExp. */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { DAY, today, holdingMatch, holdsOn, reservedUnits, reservedTodayMap, availabilityCalendar, escapeRegex };
