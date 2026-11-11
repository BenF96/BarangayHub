const mongoose = require('mongoose');

const CATEGORIES = ['Tools', 'Furniture', 'Sound System', 'Tents & Canopies', 'Kitchenware', 'Sports', 'Disaster & Rescue', 'Others'];
const CONDITIONS = ['Good', 'Fair', 'Needs Repair'];

const equipmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Name is required'], trim: true },
    category: { type: String, enum: CATEGORIES, default: 'Others' },
    description: { type: String, trim: true },
    quantity: { type: Number, required: true, min: [0, 'Quantity cannot be negative'], default: 1 },
    rentalFee: { type: Number, min: [0, 'Fee cannot be negative'], default: 0 }, // per unit, per day
    condition: { type: String, enum: CONDITIONS, default: 'Good' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Equipment', equipmentSchema);
module.exports.CATEGORIES = CATEGORIES;
module.exports.CONDITIONS = CONDITIONS;
