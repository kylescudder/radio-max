const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 8080;
const AUDIO_DIR = './audio';

app.use(cors());

// Simplified logging - exactly like the working test
app.use((req, res, next) => {
  console.log(`🚨 REQUEST: ${req.method} ${req.url}`);
  console.log(`   User-Agent: ${req.headers['user-agent'] || 'None'}`);
  console.log(`   Time: ${new Date().toISOString()}`);
  next();
});

class SimpleRadioStation {
  constructor(name, files) {
    this.name = name;
    this.files = files;
    this.currentFileIndex = 0;
    this.currentPosition = 0;
    this.clients = new Set();
    this.isPlaying = false;
    this.currentBuffer = null;
    this.fileSize = 0;
    this.broadcastInterval = null;
  }

  async start() {
    if (this.files.length === 0) return;
    
    this.isPlaying = true;
    await this.loadCurrentFile();
    this.startBroadcasting();
    console.log(`🎵 Started station: ${this.name}`);
  }

  async loadCurrentFile() {
    const currentFile = this.files[this.currentFileIndex];
    const filePath = path.join(AUDIO_DIR, currentFile);
    
    if (fs.existsSync(filePath)) {
      this.currentBuffer = fs.readFileSync(filePath);
      this.fileSize = this.currentBuffer.length;
      this.currentPosition = 0;
      console.log(`📻 Now playing: ${currentFile}`);
    }
  }

  startBroadcasting() {
    this.broadcastInterval = setInterval(() => {
      if (!this.isPlaying || !this.currentBuffer) return;

      const chunkSize = 1024;
      const endPosition = Math.min(this.currentPosition + chunkSize, this.fileSize);
      const chunk = this.currentBuffer.slice(this.currentPosition, endPosition);
      
      this.clients.forEach(client => {
        if (!client.res.destroyed) {
          try {
            client.res.write(chunk);
          } catch (error) {
            this.clients.delete(client);
          }
        } else {
          this.clients.delete(client);
        }
      });

      this.currentPosition = endPosition;
      if (this.currentPosition >= this.fileSize) {
        this.nextTrack();
      }
    }, 50);
  }

  async nextTrack() {
    this.currentFileIndex = (this.currentFileIndex + 1) % this.files.length;
    await this.loadCurrentFile();
  }

  addClient(clientRes) {
    console.log(`🎧 ETS2 connected to ${this.name}! Total clients: ${this.clients.size + 1}`);
    
    const client = { res: clientRes, id: Date.now() };
    this.clients.add(client);

    // Send the exact same headers as the working test
    clientRes.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'icy-name': this.name,
      'icy-br': '128',
      'Cache-Control': 'no-cache',
      'Connection': 'close'
    });

    // Send current audio if available
    if (this.currentBuffer && this.currentPosition < this.fileSize) {
      const remainingAudio = this.currentBuffer.slice(this.currentPosition);
      try {
        clientRes.write(remainingAudio);
      } catch (error) {
        this.clients.delete(client);
      }
    }

    return client;
  }

  removeClient(client) {
    this.clients.delete(client);
    console.log(`🔌 Client disconnected from ${this.name}. Remaining: ${this.clients.size}`);
  }
}

const radioStations = new Map();

// Initialize stations
function initializeStations() {
  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    return;
  }

  const mp3Files = fs.readdirSync(AUDIO_DIR).filter(file => file.endsWith('.mp3'));
  
  if (mp3Files.length > 0) {
    const mainStation = new SimpleRadioStation('RadioMax', mp3Files);
    radioStations.set('main', mainStation);
    mainStation.start();
  }
}

// Simple stream endpoint - exactly like the working test
app.get('/radio/main', (req, res) => {
  console.log('🎵 ETS2 connecting to RadioMax!');
  
  const station = radioStations.get('main');
  if (!station) {
    return res.status(404).send('Station not found');
  }

  const client = station.addClient(res);

  req.on('close', () => {
    station.removeClient(client);
  });

  req.on('aborted', () => {
    station.removeClient(client);
  });
});

// Test endpoint for browser testing
app.get('/test', (req, res) => {
  console.log('🧪 Browser test connection');
  
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'icy-name': 'RadioMax Test',
    'icy-br': '128'
  });

  const station = radioStations.get('main');
  if (station && station.currentBuffer) {
    res.write(station.currentBuffer);
  }

  res.end();
});

// Status endpoint
app.get('/status', (req, res) => {
  const station = radioStations.get('main');
  res.json({
    station: station ? station.name : 'No station',
    clients: station ? station.clients.size : 0,
    isPlaying: station ? station.isPlaying : false,
    currentTrack: station && station.files[station.currentFileIndex] ? 
      station.files[station.currentFileIndex] : 'None'
  });
});

// Simple test page
app.get('/', (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>RadioMax Server</h1>
        <p><a href="/status">Server Status</a></p>
        <p><a href="/test">Test Stream</a></p>
        <p>ETS2 URL: https://radio-max.kylescudder.co.uk/radio/main</p>
        <audio controls>
          <source src="/test" type="audio/mpeg">
        </audio>
      </body>
    </html>
  `);
});

initializeStations();

app.listen(PORT, () => {
  console.log(`🎵 RadioMax Server running on port ${PORT}`);
  console.log(`🚛 ETS2 URL: https://radio-max.kylescudder.co.uk/radio/main`);
  console.log(`🧪 Test: https://radio-max.kylescudder.co.uk/test`);
  console.log(`📊 Status: https://radio-max.kylescudder.co.uk/status`);
});
