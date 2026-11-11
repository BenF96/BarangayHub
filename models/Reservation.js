const mongoose = require('mongoose');

const STATUSES = ['Pending', 'Approved', 'Released', 'Returned', 'Cancelled', 'Rejected'];
// Statuses that hold equipment units (count against availability)
const ACTIVE_STATUSES = ['Pending', 'Approved', 'Released'];
// Normal workflow
const FLOW = ['Pending', 'Approved', 'Released', 'Returned'];
// Finished reservations: nothing more can happen except rent/refund entries
const CLOSED_STATUSES = ['Returned', 'Cancelled', 'Rejected'];
// Reservations that never went ahead: no rent is owed
const VOID_STATUSES = ['Cancelled', 'Rejected'];
// The only status changes allowed
const TRANSITIONS = {
  Pending: ['Approved', 'Rejected', 'Cancelled'],
  Approved: ['Released', 'Cancelled'],
  Released: ['Returned'],
  Returned: [],
  Cancelled: [],
  Rejected: [],
};

const historySchema = new mongoose.Schema(
  {
    status: { type: String, enum: STATUSES, required: true },
    at: { type: Date, default: Date.now },
    note: { type: String, trim: true },
    by: { type: String, trim: true }, // staff member who did it
  },
  { _id: false }
);

// Money in (payment) or money given back (refund)
const paymentSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['payment', 'refund'], default: 'payment' },
    amount: { type: Number, required: [true, 'Amount is required'], min: [0.01, 'Amount must be more than zero'] },
    paidAt: { type: Date, required: true, default: Date.now },
    orNumber: { type: String, trim: true }, // official receipt no.
    receivedBy: { type: String, trim: true },
    note: { type: String, trim: true },
    recordedBy: { type: String, trim: true }, // signed-in staff member who entered it
  },
  { timestamps: true }
);

const reservationSchema = new mongoose.Schema(
  {
    borrowerName: { type: String, required: [true, 'Borrower name is required'], trim: true },
    contactNumber: { type: String, required: [true, 'Contact number is required'], trim: true },
    address: { type: String, required: [true, 'Address / Purok is required'], trim: true },
    purpose: { type: String, trim: true },
    equipment: { type: mongoose.Schema.Types.ObjectId, ref: 'Equipment', required: [true, 'Equipment is required'] },
    quantity: { type: Number, required: true, min: [1, 'Quantity must be at least 1'] },
    startDate: { type: Date, required: [true, 'Start date is required'] },
    endDate: { type: Date, required: [true, 'End date is required'] },
    status: { type: String, enum: STATUSES, default: 'Pending' },
    rate: { type: Number, min: 0 }, // rent per unit per day, fixed when the reservation is made
    totalFee: { type: Number, default: 0 }, // rent = rate × quantity × days
    remarks: { type: String, trim: true },
    statusHistory: { type: [historySchema], default: [] },
    payments: { type: [paymentSchema], default: [] },
  },
  { timestamps: true }
);

// Indexes for the common lookups (lists by status, stock checks by item and dates, payment reports)
reservationSchema.index({ status: 1, startDate: -1 });
reservationSchema.index({ equipment: 1, status: 1, startDate: 1, endDate: 1 });
reservationSchema.index({ 'payments.paidAt': 1 });
reservationSchema.index({ 'payments.orNumber': 1 }, { sparse: true });
reservationSchema.index({ borrowerName: 1, contactNumber: 1 });
reservationSchema.index({ updatedAt: -1 });

const round2 = (n) => Math.round(n * 100) / 100;

reservationSchema.virtual('days').get(function () {
  const ms = this.endDate - this.startDate;
  return Math.max(1, Math.round(ms / 86400000) + 1);
});

// Short human-friendly reference number, e.g. RSV-1A2B3C
reservationSchema.virtual('refNo').get(function () {
  return 'RSV-' + String(this._id).slice(-6).toUpperCase();
});

// Rate used for the rent (older records without a stored rate: work it out from the rent)
reservationSchema.virtual('lockedRate').get(function () {
  if (this.rate != null) return this.rate;
  return this.quantity && this.days ? round2(this.totalFee / (this.quantity * this.days)) : 0;
});

reservationSchema.virtual('isClosed').get(function () {
  return CLOSED_STATUSES.includes(this.status);
});

reservationSchema.virtual('nextStatuses').get(function () {
  return TRANSITIONS[this.status] || [];
});

reservationSchema.virtual('amountPaid').get(function () {
  return round2((this.payments || []).filter((p) => p.type !== 'refund').reduce((s, p) => s + p.amount, 0));
});

reservationSchema.virtual('amountRefunded').get(function () {
  return round2((this.payments || []).filter((p) => p.type === 'refund').reduce((s, p) => s + p.amount, 0));
});

// Money the barangay is holding for this reservation
reservationSchema.virtual('netPaid').get(function () {
  return round2(this.amountPaid - this.amountRefunded);
});

// Rent actually owed: none if the reservation was cancelled or rejected
reservationSchema.virtual('rentDue').get(function () {
  return VOID_STATUSES.includes(this.status) ? 0 : this.totalFee || 0;
});

// Positive = borrower still owes; negative = barangay must refund
reservationSchema.virtual('balance').get(function () {
  return round2(this.rentDue - this.netPaid);
});

reservationSchema.virtual('refundDue').get(function () {
  return Math.max(0, -this.balance);
});

// Free / No charge / Unpaid / Partial / Paid / Refund due
reservationSchema.virtual('paymentStatus').get(function () {
  if (this.balance < 0) return 'Refund due';
  if (this.rentDue === 0) return VOID_STATUSES.includes(this.status) ? 'No charge' : 'Free';
  if (this.balance === 0) return 'Paid';
  return this.netPaid > 0 ? 'Partial' : 'Unpaid';
});

const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const localToday = () => new Date(new Date().toLocaleDateString('en-CA'));
const shortDate = (d) => new Date(d).toLocaleDateString('en-PH', { timeZone: 'UTC', month: 'short', day: 'numeric' });

// When each status was reached (first time), from the history
reservationSchema.virtual('stepDates').get(function () {
  const out = {};
  for (const h of this.statusHistory || []) if (!out[h.status]) out[h.status] = h.at;
  return out;
});

reservationSchema.virtual('daysLate').get(function () {
  const t = localToday();
  return this.status === 'Released' && this.endDate < t ? Math.round((t - this.endDate) / 86400000) : 0;
});

/**
 * What should happen next, in one line, and how urgent it is (ok / warn / bad).
 * Used on the reservation page, lists and the dashboard so they all say the same thing.
 */
reservationSchema.virtual('nextAction').get(function () {
  const t = localToday();
  const bal = this.balance;
  const owe = bal > 0 ? ` ${peso(bal)} rent unpaid.` : '';
  if (this.refundDue > 0) return { tone: 'bad', text: `Refund ${peso(this.refundDue)} to the borrower.` };
  switch (this.status) {
    case 'Pending':
      return { tone: 'warn', text: 'Waiting for approval. Approve or reject.' };
    case 'Approved': {
      const inDays = Math.round((this.startDate - t) / 86400000);
      if (inDays <= 0) return { tone: 'warn', text: `Ready for pick-up. Release when the borrower comes.${owe}` };
      return { tone: bal > 0 ? 'warn' : 'ok', text: `Pick-up on ${shortDate(this.startDate)} (in ${inDays} day${inDays > 1 ? 's' : ''}).${bal > 0 ? ' Collect ' + peso(bal) + ' rent before release.' : ' Rent paid.'}` };
    }
    case 'Released': {
      if (this.daysLate) return { tone: 'bad', text: `Overdue by ${this.daysLate} day${this.daysLate > 1 ? 's' : ''}. Follow up with the borrower.${owe}` };
      const inDays = Math.round((this.endDate - t) / 86400000);
      return { tone: bal > 0 ? 'warn' : 'ok', text: `Out with the borrower. ${inDays === 0 ? 'Due back today.' : `Due back ${shortDate(this.endDate)} (in ${inDays} day${inDays > 1 ? 's' : ''}).`}${owe}` };
    }
    case 'Returned':
      return bal > 0 ? { tone: 'bad', text: `Item returned, but ${peso(bal)} rent is still unpaid.` } : { tone: 'ok', text: 'Completed. Item returned and rent settled.' };
    default:
      return { tone: 'ok', text: `Closed (${this.status.toLowerCase()}). Nothing to do.` };
  }
});

// Record every status change (including the initial one) in the history
reservationSchema.pre('save', function () {
  if (this.isNew || this.isModified('status')) {
    this.statusHistory.push({ status: this.status, note: this.isNew ? 'Reservation made' : undefined, by: this.$locals.by });
  }
});

/** Add a note to the history without changing the status (edits, payments, refunds). */
reservationSchema.methods.log = function (note) {
  this.statusHistory.push({ status: this.status, note, by: this.$locals.by });
};

module.exports = mongoose.model('Reservation', reservationSchema);
Object.assign(module.exports, { STATUSES, ACTIVE_STATUSES, FLOW, CLOSED_STATUSES, VOID_STATUSES, TRANSITIONS });
