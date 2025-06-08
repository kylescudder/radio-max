const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 8080;
const AUDIO_DIR = './audio';

app.use(cors());

// Store active streams
const activeStreams = new Map();

class LoopingMP3Stream {
  constructor(filePath, res) {
    this.filePath = filePath;
    this.res = res;
    this.isActive = true;
    this.currentStream = null;
  }

  start() {
    this.streamLoop();
  }

  streamLoop() {
    if (!this.isActive) return;

    try {
      this.currentStream = fs.createReadStream(this.filePath);
      
      this.currentStream.on('data', (chunk) => {
        if (this.isActive && !this.res.destroyed) {
          this.res.write(chunk);
        }
      });

      this.currentStream.on('end', () => {
        // Loop the stream - start again immediately
        if (this.isActive && !this.res.destroyed) {
          setTimeout(() => this.streamLoop(), 10);
        }
      });

      this.currentStream.on('error', (error) => {
        console.error('Stream error:', error);
        this.stop();
      });

    } catch (error) {
      console.error('Error creating stream:', error);
      this.stop();
    }
  }

  stop() {
    this.isActive = false;
    if (this.currentStream) {
      this.currentStream.destroy();
    }
  }
}

// Main streaming endpoint
app.get('/stream/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(AUDIO_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  // Set proper headers for ETS2 compatibility
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'close',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Range, Content-Range, Content-Length',
    'Accept-Ranges': 'none',
    'icy-notice1': 'ETS2 Radio Stream',
    'icy-notice2': 'Custom MP3 Stream',
    'icy-name': `ETS2 Radio - ${filename.replace('.mp3', '')}`,
    'icy-genre': 'Gaming',
    'icy-url': `http://localhost:${PORT}`,
    'icy-br': '128',
    'icy-sr': '44100',
    'icy-metaint': '0',
    'Server': 'ETS2StreamServer/1.0'
  });

  // Create and start the looping stream
  const streamId = `${Date.now()}-${Math.random()}`;
  const loopStream = new LoopingMP3Stream(filePath, res);
  
  activeStreams.set(streamId, loopStream);
  loopStream.start();

  // Handle client disconnect
  req.on('close', () => {
    loopStream.stop();
    activeStreams.delete(streamId);
    console.log(`Client disconnected from ${filename}`);
  });

  req.on('aborted', () => {
    loopStream.stop();
    activeStreams.delete(streamId);
    console.log(`Client aborted connection to ${filename}`);
  });

  console.log(`Started streaming ${filename} to client`);
});

// Alternative endpoint that works better with some versions of ETS2
app.get('/radio/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(AUDIO_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  // Even simpler headers for maximum compatibility
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'icy-name': filename.replace('.mp3', ''),
    'icy-br': '128'
  });

  const streamId = `${Date.now()}-${Math.random()}`;
  const loopStream = new LoopingMP3Stream(filePath, res);
  
  activeStreams.set(streamId, loopStream);
  loopStream.start();

  req.on('close', () => {
    loopStream.stop();
    activeStreams.delete(streamId);
  });

  req.on('aborted', () => {
    loopStream.stop();
    activeStreams.delete(streamId);
  });
});

// List available files
app.get('/files', (req, res) => {
  if (!fs.existsSync(AUDIO_DIR)) {
    return res.json({ files: [] });
  }
  
  const files = fs.readdirSync(AUDIO_DIR)
    .filter(file => file.endsWith('.mp3'))
    .map(file => ({
      name: file.replace('.mp3', ''),
      streamUrl: `http://localhost:${PORT}/stream/${file}`,
      radioUrl: `http://localhost:${PORT}/radio/${file}`
    }));
  
  res.json({ 
    files,
    instructions: {
      ets2: "Use the streamUrl or radioUrl in your live_streams.sii file",
      example: "stream_data[]: \"http://localhost:8080/stream/yourfile.mp3|Your Station Name\""
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    activeStreams: activeStreams.size,
    timestamp: new Date().toISOString() 
  });
});

// Create audio directory if it doesn't exist
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  console.log(`Created ${AUDIO_DIR} directory - place your MP3 files here`);
}

app.listen(PORT, () => {
  console.log(`🎵 ETS2 MP3 Stream Server running on port ${PORT}`);
  console.log(`📁 Audio directory: ${AUDIO_DIR}`);
  console.log(`🎧 Stream format: http://localhost:${PORT}/stream/[filename.mp3]`);
  console.log(`📻 Radio format: http://localhost:${PORT}/radio/[filename.mp3]`);
  console.log(`📋 Available files: http://localhost:${PORT}/files`);
  console.log(`\n🚛 For ETS2, add to live_streams.sii:`);
  console.log(`stream_data[]: "http://localhost:${PORT}/stream/yourfile.mp3|Your Station Name"`);
});

// Cleanup on exit
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  activeStreams.forEach(stream => stream.stop());
  activeStreams.clear();
  process.exit(0);
});
