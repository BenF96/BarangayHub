const express = require('express');
const Equipment = require('../models/Equipment');
const Reservation = require('../models/Reservation');
const { today, holdingMatch, reservedUnits, escapeRegex } = require('../utils/availability');

const router = express.Router();
const { STATUSES, ACTIVE_STATUSES, FLOW, VOID_STATUSES } = Reservation;

const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const notFound = (res) => res.status(404).render('error', { title: 'Not Found', message: 'Reservation not found.' });
const back = (res, resv, msg, type, hash = '') =>
  res.redirect(`/reservations/${resv._id}?${type ? 'type=' + type + '&' : ''}msg=${encodeURIComponent(msg)}${hash}`);

// Item, units and dates can only be changed before the item is released
const canChangeItem = (resv) => resv.isNew || ['Pending', 'Approved'].includes(resv.status);

/** Copy form fields onto the reservation. Status is never taken from the form. */
function applyForm(resv, body) {
  resv.set({
    borrowerName: body.borrowerName,
    contactNumber: body.contactNumber,
    address: body.address,
    purpose: body.purpose,
    remarks: body.remarks,
  });
  if (canChangeItem(resv)) {
    resv.set({
      equipment: body.equipment || undefined,
      quantity: body.quantity,
      startDate: body.startDate || undefined,
      endDate: body.endDate || undefined,
    });
  }
}

async function renderForm(res, item, error = null, status = 200) {
  const equipmentList = await Equipment.find().sort({ name: 1 });
  res.status(status).render('reservations/form', {
    title: item.isNew ? 'New reservation' : 'Edit reservation',
    item,
    error,
    equipmentList,
    locked: !canChangeItem(item),
  });
}

/**
 * Checks dates and stock, and sets the rent.
 * The rate is taken from the item when the reservation is made (or the item is changed) and stays fixed after that,
 * so changing an item's rate later never changes existing reservations.
 */
async function checkAndPrice(resv) {
  if (resv.endDate < resv.startDate) return 'Return date cannot be before the pick-up date.';
  const itemChanged = resv.isNew || resv.isModified('equipment');
  const bookingChanged = itemChanged || resv.isModified('quantity') || resv.isModified('startDate') || resv.isModified('endDate');
  if (!bookingChanged) return null;

  const equipment = await Equipment.findById(resv.equipment);
  if (!equipment) return 'The selected item does not exist.';

  if (ACTIVE_STATUSES.includes(resv.status)) {
    const used = await reservedUnits(equipment._id, resv.startDate, resv.endDate, resv.isNew ? null : resv._id);
    const available = equipment.quantity - used;
    if (resv.quantity > available) {
      return `Only ${Math.max(0, available)} of ${equipment.quantity} "${equipment.name}" are free for those dates.`;
    }
  }
  resv.rate = itemChanged ? equipment.rentalFee : resv.lockedRate;
  resv.totalFee = Math.round(resv.rate * resv.quantity * resv.days * 100) / 100;
  return null;
}

/** Plain-language list of what an edit changed, for the history log. */
function describeChanges(resv, before) {
  const out = [];
  if (before.equipment !== String(resv.equipment)) out.push('item changed');
  if (before.quantity !== resv.quantity) out.push(`units ${before.quantity} → ${resv.quantity}`);
  if (before.dates !== `${fmt(resv.startDate)}–${fmt(resv.endDate)}`) out.push(`dates ${before.dates} → ${fmt(resv.startDate)}–${fmt(resv.endDate)}`);
  if (before.totalFee !== resv.totalFee) out.push(`rent ${peso(before.totalFee)} → ${peso(resv.totalFee)}`);
  if (before.borrower !== `${resv.borrowerName}|${resv.contactNumber}|${resv.address}`) out.push('borrower details');
  return out;
}

// LIST with search + status filter
router.get('/', async (req, res) => {
  const { q = '', status = '' } = req.query;
  const filter = {};
  if (q) filter.borrowerName = { $regex: escapeRegex(q), $options: 'i' };
  if (status === 'Overdue') Object.assign(filter, { status: 'Released', endDate: { $lt: today() } });
  else if (status) filter.status = status;
  const items = await Reservation.find(filter).populate('equipment').sort({ startDate: -1 });
  const totals = {
    count: items.length,
    units: items.reduce((s, x) => s + x.quantity, 0),
    fees: items.reduce((s, x) => s + x.rentDue, 0),
    paid: items.reduce((s, x) => s + x.netPaid, 0),
  };
  res.render('reservations/index', { title: 'Reservations', items, q, status, STATUSES, totals, today: today() });
});

// AVAILABILITY (JSON, used live by the reservation form): free units for an item over a date range
router.get('/availability', async (req, res) => {
  const isId = (s) => /^[a-f0-9]{24}$/i.test(s || '');
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const { equipment, start, end, exclude } = req.query;
  if (!isId(equipment) || !isDate(start) || !isDate(end)) return res.status(400).json({ error: 'Choose an item and both dates.' });
  const s = new Date(start), e = new Date(end);
  if (e < s) return res.status(400).json({ error: 'Return date is before the pick-up date.' });
  const eq = await Equipment.findById(equipment);
  if (!eq) return res.status(404).json({ error: 'Item not found.' });
  const match = { equipment: eq._id, ...holdingMatch(s, e) }; // includes overdue items still out
  if (isId(exclude)) match._id = { $ne: exclude };
  const others = await Reservation.find(match).sort({ startDate: 1 }).limit(50);
  const booked = others.reduce((sum, r) => sum + r.quantity, 0);
  res.json({
    name: eq.name,
    category: eq.category,
    condition: eq.condition,
    owned: eq.quantity,
    booked,
    free: Math.max(0, eq.quantity - booked),
    rate: eq.rentalFee,
    days: Math.round((e - s) / 86400000) + 1,
    bookings: others.map((r) => ({ refNo: r.refNo, id: r._id, borrower: r.borrowerName, units: r.quantity, start: fmt(r.startDate), end: fmt(r.endDate), status: r.status })),
  });
});

// NEW form (optionally preselect item via ?equipment=id)
router.get('/new', (req, res) => {
  const item = new Reservation({ quantity: 1 });
  if (/^[a-f0-9]{24}$/i.test(req.query.equipment || '')) item.equipment = req.query.equipment;
  return renderForm(res, item);
});

// CREATE — always starts as Pending
router.post('/', async (req, res) => {
  const resv = new Reservation({ status: 'Pending' });
  applyForm(resv, req.body);
  try {
    await resv.validate();
  } catch (err) {
    if (err.name !== 'ValidationError') throw err;
    return renderForm(res, resv, err.message, 400);
  }
  const error = await checkAndPrice(resv);
  if (error) return renderForm(res, resv, error, 400);
  await resv.save();
  back(res, resv, `Reservation ${resv.refNo} saved as Pending. Rent: ${resv.totalFee ? peso(resv.totalFee) : 'free'}.`);
});

// VIEW
router.get('/:id', async (req, res) => {
  const item = await Reservation.findById(req.params.id).populate('equipment');
  if (!item) return notFound(res);

  // Borrower's other reservations (same name and contact number)
  const others = await Reservation.find({
    _id: { $ne: item._id },
    borrowerName: { $regex: '^' + escapeRegex(item.borrowerName) + '$', $options: 'i' },
    contactNumber: item.contactNumber,
  })
    .populate('equipment')
    .sort({ startDate: -1 });
  const borrower = {
    others,
    total: others.length + 1,
    active: others.filter((r) => ACTIVE_STATUSES.includes(r.status)).length,
    returned: others.filter((r) => r.status === 'Returned').length,
    lateBefore: others.filter((r) => r.daysLate > 0).length,
    unpaidElsewhere: others.reduce((s, r) => s + Math.max(0, r.balance), 0),
  };

  // Item stock around these dates
  let stock = null;
  if (item.equipment) {
    const otherBooked = await reservedUnits(item.equipment._id, item.startDate, item.endDate, item._id);
    stock = { owned: item.equipment.quantity, otherBooked, freeAfterThis: item.equipment.quantity - otherBooked - (ACTIVE_STATUSES.includes(item.status) ? item.quantity : 0) };
  }

  res.render('reservations/show', { title: 'Reservation ' + item.refNo, item, FLOW, borrower, stock, today: today() });
});

// EDIT form
router.get('/:id/edit', async (req, res) => {
  const item = await Reservation.findById(req.params.id);
  if (!item) return notFound(res);
  renderForm(res, item);
});

// UPDATE (details only — status changes go through the status buttons)
router.put('/:id', async (req, res) => {
  const resv = await Reservation.findById(req.params.id);
  if (!resv) return notFound(res);
  const before = {
    equipment: String(resv.equipment),
    quantity: resv.quantity,
    dates: `${fmt(resv.startDate)}–${fmt(resv.endDate)}`,
    totalFee: resv.totalFee,
    borrower: `${resv.borrowerName}|${resv.contactNumber}|${resv.address}`,
  };
  applyForm(resv, req.body);
  try {
    await resv.validate();
  } catch (err) {
    if (err.name !== 'ValidationError') throw err;
    return renderForm(res, resv, err.message, 400);
  }
  const error = await checkAndPrice(resv);
  if (error) return renderForm(res, resv, error, 400);
  const changes = describeChanges(resv, before);
  if (changes.length) resv.log('Edited: ' + changes.join('; '));
  await resv.save();
  let msg = 'Reservation updated.';
  if (resv.balance < 0) msg += ` The rent is now lower than what was paid. Refund ${peso(-resv.balance)}.`;
  back(res, resv, msg);
});

// STATUS change — only the allowed next steps
router.patch('/:id/status', async (req, res) => {
  const resv = await Reservation.findById(req.params.id);
  if (!resv) return notFound(res);
  const to = req.body.status;
  if (!resv.nextStatuses.includes(to)) {
    return back(res, resv, `Can't change from ${resv.status} to ${to}. Allowed: ${resv.nextStatuses.join(', ') || 'none (closed)'}.`, 'error');
  }
  const unpaidAtRelease = to === 'Released' && resv.balance > 0 ? resv.balance : 0;
  resv.status = to;
  await resv.save(); // pre-save hook adds the history entry
  const note = [(req.body.note || '').trim(), unpaidAtRelease ? `released with ${peso(unpaidAtRelease)} unpaid` : '']
    .filter(Boolean)
    .join(' · ');
  if (note) {
    resv.statusHistory[resv.statusHistory.length - 1].note = note;
    resv.markModified('statusHistory');
    await resv.save();
  }
  let msg = `Marked as ${to}.`;
  if (unpaidAtRelease) msg += ` Rent not fully paid: ${peso(unpaidAtRelease)} still to collect.`;
  if (VOID_STATUSES.includes(to) && resv.refundDue > 0) msg += ` ${peso(resv.refundDue)} was paid, record the refund.`;
  back(res, resv, msg, unpaidAtRelease ? 'error' : '', unpaidAtRelease || resv.refundDue ? '#payments' : '');
});

// PAYMENT (money in) or REFUND (money back)
router.post('/:id/payments', async (req, res) => {
  const resv = await Reservation.findById(req.params.id);
  if (!resv) return notFound(res);
  const type = req.body.type === 'refund' ? 'refund' : 'payment';
  const fail = (m) => back(res, resv, m, 'error', '#payments');

  const amount = Math.round(Number(req.body.amount) * 100) / 100;
  if (!(amount > 0)) return fail('Enter an amount greater than zero.');
  const paidAt = req.body.paidAt ? new Date(req.body.paidAt) : today();
  if (isNaN(paidAt)) return fail('Enter a valid date.');
  if (paidAt > today()) return fail('The date cannot be in the future.');

  if (type === 'payment') {
    if (resv.balance <= 0) return fail('Nothing is owed on this reservation.');
    if (amount > resv.balance) return fail(`That is more than the ${peso(resv.balance)} still owed.`);
  } else {
    if (resv.refundDue <= 0) return fail('No refund is due on this reservation.');
    if (amount > resv.refundDue) return fail(`That is more than the ${peso(resv.refundDue)} refund due.`);
  }

  const orNumber = (req.body.orNumber || '').trim();
  if (type === 'payment' && orNumber && (await Reservation.exists({ payments: { $elemMatch: { orNumber, type: { $ne: 'refund' } } } }))) {
    return fail(`OR no. ${orNumber} has already been used.`);
  }

  resv.payments.push({ type, amount, paidAt, orNumber, receivedBy: req.body.receivedBy, note: req.body.note });
  resv.log(`${type === 'refund' ? 'Refunded' : 'Paid'} ${peso(amount)}${orNumber ? ' (OR ' + orNumber + ')' : ''}`);
  try {
    await resv.save();
  } catch (err) {
    if (err.name !== 'ValidationError') throw err;
    return fail(err.message);
  }
  let msg;
  if (type === 'refund') msg = resv.refundDue > 0 ? `Refund recorded. ${peso(resv.refundDue)} still to refund.` : 'Refund recorded. Settled.';
  else msg = resv.balance > 0 ? `Payment recorded. Balance: ${peso(resv.balance)}.` : 'Payment recorded. Fully paid.';
  back(res, resv, msg, '', '#payments');
});

// Remove a payment/refund entered by mistake (kept in the history log)
router.delete('/:id/payments/:paymentId', async (req, res) => {
  const resv = await Reservation.findById(req.params.id);
  if (!resv) return notFound(res);
  const p = resv.payments.id(req.params.paymentId);
  if (p) {
    resv.log(`Removed ${p.type === 'refund' ? 'refund' : 'payment'} entry of ${peso(p.amount)}${p.orNumber ? ' (OR ' + p.orNumber + ')' : ''} dated ${fmt(p.paidAt)}`);
    p.deleteOne();
    await resv.save();
  }
  back(res, resv, 'Entry removed. It is noted in the history.', '', '#payments');
});

// DELETE reservation — not allowed once money has been recorded
router.delete('/:id', async (req, res) => {
  const resv = await Reservation.findById(req.params.id);
  if (resv && resv.payments.length) {
    return back(res, resv, 'This reservation has money recorded, so it is kept for the books. Cancel it instead.', 'error');
  }
  await Reservation.findByIdAndDelete(req.params.id);
  res.redirect('/reservations?msg=' + encodeURIComponent('Reservation deleted.'));
});

module.exports = router;
