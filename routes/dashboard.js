// Dashboard: today's work, upcoming pick-ups, stock and rent overview
const express = require('express');
const Equipment = require('../models/Equipment');
const Reservation = require('../models/Reservation');
const { DAY, today, reservedTodayMap } = require('../utils/availability');

const router = express.Router();

router.get('/', async (req, res) => {
  const t = today();
  const in7 = new Date(t.getTime() + 7 * DAY);
  const [equipment, reservedMap, statusRows, revenueRows, toRelease, toReturn, upcoming, recent, open] = await Promise.all([
    Equipment.find().sort({ name: 1 }),
    reservedTodayMap(),
    Reservation.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    // Rent: collected this month, and unpaid balances still owed
    Reservation.aggregate([
      {
        $facet: {
          // Net money in this month (refunds subtracted)
          month: [
            { $unwind: '$payments' },
            { $match: { 'payments.paidAt': { $gte: new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)) } } },
            {
              $group: {
                _id: null,
                total: { $sum: { $cond: [{ $eq: ['$payments.type', 'refund'] }, { $multiply: ['$payments.amount', -1] }, '$payments.amount'] } },
                payments: { $sum: { $cond: [{ $eq: ['$payments.type', 'refund'] }, 0, 1] } },
                refunds: { $sum: { $cond: [{ $eq: ['$payments.type', 'refund'] }, 1, 0] } },
              },
            },
          ],
          // Owed only once approved (pending requests are not debts yet)
          owing: [
            { $match: { status: { $in: ['Approved', 'Released', 'Returned'] }, totalFee: { $gt: 0 } } },
            {
              $project: {
                bal: {
                  $subtract: [
                    '$totalFee',
                    {
                      $sum: {
                        $map: {
                          input: { $ifNull: ['$payments', []] },
                          as: 'p',
                          in: { $cond: [{ $eq: ['$$p.type', 'refund'] }, { $multiply: ['$$p.amount', -1] }, '$$p.amount'] },
                        },
                      },
                    },
                  ],
                },
              },
            },
            { $match: { bal: { $gt: 0.004 } } },
            { $group: { _id: null, total: { $sum: '$bal' }, n: { $sum: 1 } } },
          ],
        },
      },
    ]),
    Reservation.find({ status: 'Approved', startDate: { $lte: t } }).populate('equipment').sort({ startDate: 1 }),
    Reservation.find({ status: 'Released', endDate: { $lte: t } }).populate('equipment').sort({ endDate: 1 }),
    Reservation.find({ status: { $in: ['Pending', 'Approved'] }, startDate: { $gt: t, $lte: in7 } })
      .populate('equipment').sort({ startDate: 1 }).limit(8),
    Reservation.find().populate('equipment').sort({ updatedAt: -1 }).limit(6),
    // Open bookings, for the detail lines on the summary cards
    Reservation.find({ status: { $in: ['Pending', 'Approved', 'Released'] } }).select('status quantity totalFee startDate endDate payments rate'),
  ]);

  const sumOf = (list, f) => list.reduce((s, r) => s + f(r), 0);
  const pendingList = open.filter((r) => r.status === 'Pending');
  const approvedList = open.filter((r) => r.status === 'Approved');
  const releasedList = open.filter((r) => r.status === 'Released');
  const overdueList = releasedList.filter((r) => r.endDate < t);
  const detail = {
    pendingExpected: sumOf(pendingList, (r) => r.totalFee),
    pendingUnits: sumOf(pendingList, (r) => r.quantity),
    oldestPending: pendingList.reduce((m, r) => (!m || r.startDate < m ? r.startDate : m), null),
    approvedUnits: sumOf(approvedList, (r) => r.quantity),
    approvedUnpaid: sumOf(approvedList, (r) => Math.max(0, r.balance)),
    approvedToday: approvedList.filter((r) => r.startDate <= t).length,
    releasedUnits: sumOf(releasedList, (r) => r.quantity),
    dueToday: releasedList.filter((r) => r.endDate.getTime() === t.getTime()).length,
    overdueUnits: sumOf(overdueList, (r) => r.quantity),
    maxLate: overdueList.reduce((m, r) => Math.max(m, Math.round((t - r.endDate) / DAY)), 0),
    monthPayments: revenueRows[0].month[0]?.payments || 0,
    monthRefunds: revenueRows[0].month[0]?.refunds || 0,
  };

  const byStatus = Object.fromEntries(statusRows.map((r) => [r._id, r.n]));
  const totalUnits = equipment.reduce((s, e) => s + e.quantity, 0);
  const unitsOut = Object.values(reservedMap).reduce((s, n) => s + n, 0);

  // Units per category with how many are in use today
  const categories = {};
  for (const e of equipment) {
    const c = (categories[e.category] ||= { total: 0, used: 0, items: 0 });
    c.items++;
    c.total += e.quantity;
    c.used += Math.min(e.quantity, reservedMap[String(e._id)] || 0);
  }

  const needsRepair = equipment.filter((e) => e.condition === 'Needs Repair');
  const fullyBooked = equipment.filter((e) => e.quantity > 0 && (reservedMap[String(e._id)] || 0) >= e.quantity);

  res.render('index', {
    title: 'Dashboard',
    stats: {
      equipmentCount: equipment.length,
      totalUnits,
      unitsOut,
      availableUnits: Math.max(0, totalUnits - unitsOut),
      totalReservations: statusRows.reduce((s, r) => s + r.n, 0),
      collectedMonth: revenueRows[0].month[0]?.total || 0,
      owing: revenueRows[0].owing[0]?.total || 0,
      owingCount: revenueRows[0].owing[0]?.n || 0,
    },
    byStatus,
    detail,
    categories,
    toRelease,
    toReturn,
    upcoming,
    recent,
    needsRepair,
    fullyBooked,
    today: t,
  });
});

module.exports = router;
