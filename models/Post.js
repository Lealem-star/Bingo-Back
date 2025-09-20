const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
    kind: { type: String, enum: ['image', 'video'], required: true },
    url: { type: String, required: true },
    filename: { type: String }, // Store the uploaded filename
    caption: { type: String, default: '' },
    active: { type: Boolean, default: true },
}, { timestamps: true });

postSchema.index({ createdAt: -1 });
postSchema.index({ active: 1 });

module.exports = mongoose.model('Post', postSchema);


