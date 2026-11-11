const express = require('express');
const Equipment = require('../models/Equipment');
const Reservation = require('../models/Reservation');
const { today, holdingMatch, holdsOn, reservedTodayMap, availabilityCalendar, escapeRegex } = require('../utils/availability');

const router = express.Router();
const { CATEGORIES, CONDITIONS } = Equipment;

const pick = (body) => ({
  name: body.name,
  category: body.category,
  description: body.description,
  quantity: body.quantity,
  rentalFee: body.rentalFee || 0,
  condition: body.condition,
});

const notFound = (res) => res.status(404).render('error', { title: 'Not Found', message: 'Equipment not found.' });

async function renderForm(res, item, error = null, status = 200) {
  // For an existing item: what its open bookings look like, so the edit's effect is clear
  let usage = null;
  if (!item.isNew) {
    const open = await Reservation.find({ equipment: item._id, status: { $in: Reservation.ACTIVE_STATUSES } });
    const peak = await peakBooked(item._id);
    usage = {
      open: open.length,
      units: open.reduce((s, r) => s + r.quantity, 0),
      peak,
      oldRate: open.filter((r) => r.lockedRate !== item.rentalFee).length,
      total: await Reservation.countDocuments({ equipment: item._id }),
    };
  }
  res.status(status).render('equipment/form', {
    title: item.isNew ? 'Add Equipment' : 'Edit Equipment',
    item,
    error,
    usage,
    CATEGORIES,
    CONDITIONS,
  });
}

// READ: list (with search + category filter)
router.get('/', async (req, res) => {
  const { q = '', category = '' } = req.query;
  const filter = {};
  if (q) filter.name = { $regex: escapeRegex(q), $options: 'i' };
  if (category) filter.category = category;
  const t = today();
  const [items, reserved, open] = await Promise.all([
    Equipment.find(filter).sort({ name: 1 }),
    reservedTodayMap(),
    Reservation.find({ status: { $in: ['Pending', 'Approved', 'Released', 'Returned'] } }).select('equipment status quantity startDate endDate totalFee payments rate'),
  ]);
  // Per item: units out now, upcoming bookings, overdue, unpaid rent
  const extra = {};
  for (const r of open) {
    const k = String(r.equipment);
    const e = (extra[k] ||= { outNow: 0, upcoming: 0, upcomingUnits: 0, overdue: 0, unpaid: 0, nextDate: null });
    if (r.status === 'Released') {
      e.outNow += r.quantity;
      if (r.endDate < t) e.overdue++;
    }
    if (['Pending', 'Approved'].includes(r.status) && r.startDate > t) {
      e.upcoming++;
      e.upcomingUnits += r.quantity;
      if (!e.nextDate || r.startDate < e.nextDate) e.nextDate = r.startDate;
    }
    if (r.status !== 'Pending' && r.balance > 0) e.unpaid += r.balance;
  }
  const totals = {
    units: items.reduce((s, e) => s + e.quantity, 0),
    outNow: items.reduce((s, e) => s + (extra[String(e._id)]?.outNow || 0), 0),
    upcoming: items.reduce((s, e) => s + (extra[String(e._id)]?.upcoming || 0), 0),
    unpaid: items.reduce((s, e) => s + (extra[String(e._id)]?.unpaid || 0), 0),
    repair: items.filter((e) => e.condition === 'Needs Repair').length,
  };
  res.render('equipment/index', { title: 'Equipment & Tools', items, reserved, extra, totals, q, category, CATEGORIES });
});

// CREATE: form
router.get('/new', (req, res) => renderForm(res, new Equipment()));

// CREATE: submit
router.post('/', async (req, res) => {
  const item = new Equipment(pick(req.body));
  try {
    await item.save();
    res.redirect('/equipment?msg=' + encodeURIComponent(`"${item.name}" added.`));
  } catch (err) {
    if (err.name !== 'ValidationError') throw err;
    renderForm(res, item, err.message, 400);
  }
});

// READ: single item with usage statistics, 14-day availability and history
router.get('/:id', async (req, res) => {
  const item = await Equipment.findById(req.params.id);
  if (!item) return notFound(res);
  const t = today();
  const [reservations, reservedMap, calendar] = await Promise.all([
    Reservation.find({ equipment: item._id }).sort({ startDate: -1 }),
    reservedTodayMap(),
    availabilityCalendar(item, 14),
  ]);
  const completed = reservations.filter((r) => ['Released', 'Returned'].includes(r.status));
  const stats = {
    reservedToday: reservedMap[String(item._id)] || 0,
    outNow: reservations.filter((r) => r.status === 'Released').reduce((s, r) => s + r.quantity, 0),
    upcoming: reservations.filter((r) => ['Pending', 'Approved'].includes(r.status) && r.startDate > t),
    timesBorrowed: completed.length,
    unitDays: completed.reduce((s, r) => s + r.quantity * r.days, 0),
    revenue: reservations.reduce((s, r) => s + r.netPaid, 0), // rent actually received, less refunds
    owedTotal: reservations.filter((r) => ['Approved', 'Released', 'Returned'].includes(r.status)).reduce((s, r) => s + r.rentDue, 0),
    unpaid: reservations.filter((r) => ['Approved', 'Released', 'Returned'].includes(r.status)).reduce((s, r) => s + Math.max(0, r.balance), 0),
    expected: reservations.filter((r) => r.status === 'Pending').reduce((s, r) => s + r.totalFee, 0),
    oldRate: reservations.filter((r) => ['Pending', 'Approved', 'Released'].includes(r.status) && r.lockedRate !== item.rentalFee).length,
    pending: reservations.filter((r) => r.status === 'Pending').length,
    approved: reservations.filter((r) => r.status === 'Approved').length,
    released: reservations.filter((r) => r.status === 'Released').length,
    returned: reservations.filter((r) => r.status === 'Returned').length,
    closed: reservations.filter((r) => ['Cancelled', 'Rejected'].includes(r.status)).length,
    overdue: reservations.filter((r) => r.status === 'Released' && r.endDate < t).length,
  };
  res.render('equipment/show', { title: item.name, item, reservations, stats, calendar, today: t });
});

/** Highest number of units booked on any single day from today onward. */
async function peakBooked(equipmentId) {
  const t = today();
  // Bookings holding units from today on (overdue items still count until returned)
  const far = new Date(8640000000000000);
  const rows = await Reservation.find({ equipment: equipmentId, ...holdingMatch(t, far) }).select('quantity startDate endDate status');
  let best = { units: 0, date: '' };
  // Peak is always on some reservation's start day (or today)
  const days = new Set([t.getTime(), ...rows.map((r) => Math.max(r.startDate.getTime(), t.getTime()))]);
  for (const d of days) {
    const units = rows.filter((r) => holdsOn(r, new Date(d))).reduce((s, r) => s + r.quantity, 0);
    if (units > best.units) best = { units, date: new Date(d).toISOString().slice(0, 10) };
  }
  return best;
}

// UPDATE: form
router.get('/:id/edit', async (req, res) => {
  const item = await Equipment.findById(req.params.id);
  if (!item) return notFound(res);
  renderForm(res, item);
});

// UPDATE: submit
router.put('/:id', async (req, res) => {
  const item = await Equipment.findById(req.params.id);
  if (!item) return notFound(res);
  const oldRate = item.rentalFee;
  item.set(pick(req.body));

  // Don't allow fewer units than are already booked on any day from today on
  const peak = await peakBooked(item._id);
  if (Number(item.quantity) < peak.units) {
    return renderForm(
      res,
      item,
      `${peak.units} units are already booked on ${peak.date}. Reduce or cancel those reservations before lowering the count below ${peak.units}.`,
      400
    );
  }
  try {
    await item.save();
    let msg = 'Item updated.';
    if (item.rentalFee !== oldRate) msg += ' The new rate applies to new reservations only. Existing ones keep their rate.';
    res.redirect(`/equipment/${item._id}?msg=` + encodeURIComponent(msg));
  } catch (err) {
    if (err.name !== 'ValidationError') throw err;
    renderForm(res, item, err.message, 400);
  }
});

// DELETE (blocked while active reservations exist)
router.delete('/:id', async (req, res) => {
  const active = await Reservation.countDocuments({
    equipment: req.params.id,
    status: { $in: Reservation.ACTIVE_STATUSES },
  });
  if (active > 0) {
    return res.redirect(
      `/equipment/${req.params.id}?type=error&msg=` +
        encodeURIComponent(`Cannot delete: ${active} active reservation(s) still use this item.`)
    );
  }
  const item = await Equipment.findByIdAndDelete(req.params.id);
  // Remove the item's past reservations, but keep any with recorded payments (needed for the collections report)
  await Reservation.deleteMany({ equipment: req.params.id, 'payments.0': { $exists: false } });
  res.redirect('/equipment?msg=' + encodeURIComponent(`"${item ? item.name : 'Item'}" deleted.`));
});

module.exports = router;
