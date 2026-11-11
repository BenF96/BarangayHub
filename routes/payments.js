// Rent: money received/refunded in a period, rent still owed, rent expected, refunds due
const express = require('express');
const Reservation = require('../models/Reservation');
const { DAY, today } = require('../utils/availability');

const router = express.Router();
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

router.get('/', async (req, res) => {
  const t = today();
  const monthStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
  const from = isDate(req.query.from) ? new Date(req.query.from) : monthStart;
  const to = isDate(req.query.to) ? new Date(req.query.to) : t;
  const toEnd = new Date(to.getTime() + DAY - 1); // include the whole "to" day

  // Every payment and refund in the period (one row each)
  const entries = await Reservation.aggregate([
    { $match: { 'payments.paidAt': { $gte: from, $lte: toEnd } } },
    { $unwind: '$payments' },
    { $match: { 'payments.paidAt': { $gte: from, $lte: toEnd } } },
    { $lookup: { from: 'equipment', localField: 'equipment', foreignField: '_id', as: 'eq' } },
    { $sort: { 'payments.paidAt': -1, 'payments.createdAt': -1 } },
    {
      $project: {
        reservationId: '$_id',
        borrowerName: 1,
        quantity: 1,
        equipmentName: { $ifNull: [{ $arrayElemAt: ['$eq.name', 0] }, '(deleted)'] },
        payment: '$payments',
      },
    },
  ]);
  entries.forEach((p) => {
    p.refNo = 'RSV-' + String(p.reservationId).slice(-6).toUpperCase();
    p.isRefund = p.payment.type === 'refund';
  });
  const received = entries.filter((e) => !e.isRefund).reduce((s, e) => s + e.payment.amount, 0);
  const refunded = entries.filter((e) => e.isRefund).reduce((s, e) => s + e.payment.amount, 0);

  const all = await Reservation.find({ $or: [{ totalFee: { $gt: 0 } }, { 'payments.0': { $exists: true } }] })
    .populate('equipment')
    .sort({ startDate: 1 });
  // Owed: approved and later only (the borrower has been told yes)
  const owing = all.filter((r) => ['Approved', 'Released', 'Returned'].includes(r.status) && r.balance > 0);
  // Expected: still waiting for approval
  const expected = all.filter((r) => r.status === 'Pending' && r.balance > 0);
  // Barangay must give money back
  const refunds = all.filter((r) => r.refundDue > 0);
  const sum = (list, f) => list.reduce((s, r) => s + f(r), 0);

  // Current balance of each reservation that appears in the collections list
  const balances = {};
  const ids = [...new Set(entries.map((e) => String(e.reservationId)))];
  for (const r of await Reservation.find({ _id: { $in: ids } })) {
    balances[String(r._id)] = { balance: r.balance, status: r.paymentStatus };
  }

  res.render('payments/index', {
    title: 'Rent & payments',
    entries,
    balances,
    received,
    refunded,
    owing,
    owingTotal: sum(owing, (r) => r.balance),
    expected,
    expectedTotal: sum(expected, (r) => r.balance),
    refunds,
    refundTotal: sum(refunds, (r) => r.refundDue),
    from,
    to,
    today: t,
  });
});

module.exports = router;
