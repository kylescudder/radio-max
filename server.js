const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 8080;
const AUDIO_DIR = './audio';

app.use(cors());

// Stream MP3 files
app.get('/stream/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(AUDIO_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const stat = fs.statSync(filePath);
  
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('icy-name', `ETS2 Radio - ${filename}`);
  
  const readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
});

// List available files
app.get('/files', (req, res) => {
  if (!fs.existsSync(AUDIO_DIR)) {
    return res.json({ files: [] });
  }
  
  const files = fs.readdirSync(AUDIO_DIR)
    .filter(file => file.endsWith('.mp3'))
    .map(file => ({
      name: file,
      url: `http://localhost:${PORT}/stream/${file}`
    }));
  
  res.json({ files });
});

// Create audio directory if it doesn't exist
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  console.log(`Created ${AUDIO_DIR} directory`);
}

app.listen(PORT, () => {
  console.log(`🎵 Simple MP3 Server running on port ${PORT}`);
  console.log(`📁 Place your MP3 files in: ${AUDIO_DIR}`);
  console.log(`🎧 Stream URLs: http://localhost:${PORT}/stream/[filename.mp3]`);
  console.log(`📋 File list: http://localhost:${PORT}/files`);
});
