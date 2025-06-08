const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 8080;
const AUDIO_DIR = './audio';

app.use(cors());

class RadioStation {
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
    this.chunkSize = 1024; // Broadcast in 1KB chunks
  }

  async start() {
    if (this.files.length === 0) {
      console.log(`No files found for station: ${this.name}`);
      return;
    }

    this.isPlaying = true;
    await this.loadCurrentFile();
    this.startBroadcasting();
    console.log(`🎵 Started radio station: ${this.name}`);
  }

  async loadCurrentFile() {
    const currentFile = this.files[this.currentFileIndex];
    const filePath = path.join(AUDIO_DIR, currentFile);
    
    if (fs.existsSync(filePath)) {
      this.currentBuffer = fs.readFileSync(filePath);
      this.fileSize = this.currentBuffer.length;
      this.currentPosition = 0;
      console.log(`📻 Now playing: ${currentFile} on ${this.name}`);
    } else {
      console.error(`File not found: ${filePath}`);
    }
  }

  startBroadcasting() {
    this.broadcastInterval = setInterval(() => {
      if (!this.isPlaying || !this.currentBuffer) return;

      // Calculate how much to send this interval
      const endPosition = Math.min(
        this.currentPosition + this.chunkSize, 
        this.fileSize
      );
      
      const chunk = this.currentBuffer.slice(this.currentPosition, endPosition);
      
      // Send chunk to all connected clients
      this.clients.forEach(client => {
        if (!client.res.destroyed) {
          try {
            client.res.write(chunk);
          } catch (error) {
            console.log('Client disconnected during broadcast');
            this.clients.delete(client);
          }
        } else {
          this.clients.delete(client);
        }
      });

      this.currentPosition = endPosition;

      // Check if we've reached the end of the file
      if (this.currentPosition >= this.fileSize) {
        this.nextTrack();
      }
    }, 50); // Broadcast every 50ms for smooth playback
  }

  async nextTrack() {
    this.currentFileIndex = (this.currentFileIndex + 1) % this.files.length;
    await this.loadCurrentFile();
  }

  addClient(client) {
    this.clients.add(client);
    
    // Send ICY headers to new client
    this.sendIcyHeaders(client.res);
    
    // If we're in the middle of a track, send remaining audio
    if (this.currentBuffer && this.currentPosition < this.fileSize) {
      const remainingAudio = this.currentBuffer.slice(this.currentPosition);
      try {
        client.res.write(remainingAudio);
      } catch (error) {
        console.log('Error sending initial audio to client');
        this.clients.delete(client);
      }
    }

    console.log(`📻 Client connected to ${this.name} (${this.clients.size} total)`);
  }

  removeClient(client) {
    this.clients.delete(client);
    console.log(`📻 Client disconnected from ${this.name} (${this.clients.size} total)`);
  }

  sendIcyHeaders(res) {
    const currentFile = this.files[this.currentFileIndex];
    const headers = [
      'ICY 200 OK',
      'icy-notice1: ETS2 Custom Radio',
      'icy-notice2: Streaming for Euro Truck Simulator 2',
      `icy-name: ${this.name}`,
      'icy-genre: Gaming Music',
      'icy-url: http://localhost:8080',
      'icy-br: 128',
      'icy-sr: 44100',
      'icy-pub: 1',
      'icy-metaint: 16000',
      'Content-Type: audio/mpeg',
      'Cache-Control: no-cache',
      'Connection: close',
      '',
      ''
    ].join('\r\n');

    res.write(headers);
  }

  getCurrentTrackInfo() {
    const currentFile = this.files[this.currentFileIndex];
    const progressPercent = ((this.currentPosition / this.fileSize) * 100).toFixed(1);
    
    return {
      currentTrack: currentFile,
      position: this.currentPosition,
      fileSize: this.fileSize,
      progressPercent: progressPercent,
      listeners: this.clients.size
    };
  }

  stop() {
    this.isPlaying = false;
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
    }
    
    this.clients.forEach(client => {
      if (!client.res.destroyed) {
        client.res.end();
      }
    });
    this.clients.clear();
  }
}

// Create radio stations
const radioStations = new Map();

function initializeStations() {
  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    console.log(`Created ${AUDIO_DIR} directory - please add MP3 files`);
    return;
  }

  const mp3Files = fs.readdirSync(AUDIO_DIR)
    .filter(file => file.endsWith('.mp3'));

  if (mp3Files.length === 0) {
    console.log('⚠️  No MP3 files found in audio directory');
    return;
  }

  // Create stations - you can organize files into different stations
  const station1Files = mp3Files.slice(0, Math.ceil(mp3Files.length / 2));
  const station2Files = mp3Files.slice(Math.ceil(mp3Files.length / 2));

  if (station1Files.length > 0) {
    const station1 = new RadioStation('ETS2 Radio Rock', station1Files);
    radioStations.set('rock', station1);
    station1.start();
  }

  if (station2Files.length > 0) {
    const station2 = new RadioStation('ETS2 Radio Chill', station2Files);
    radioStations.set('chill', station2);
    station2.start();
  }

  // If you have only a few files, create one station with all files
  if (mp3Files.length <= 3) {
    radioStations.clear();
    const mainStation = new RadioStation('ETS2 Radio Main', mp3Files);
    radioStations.set('main', mainStation);
    mainStation.start();
  }
}

// Stream endpoint
app.get('/radio/:stationId', (req, res) => {
  const stationId = req.params.stationId;
  const station = radioStations.get(stationId);

  if (!station) {
    return res.status(404).send('Station not found');
  }

  const client = { res, id: Date.now() };
  station.addClient(client);

  req.on('close', () => {
    station.removeClient(client);
  });

  req.on('aborted', () => {
    station.removeClient(client);
  });
});

// Station info endpoint
app.get('/stations', (req, res) => {
  const stationList = Array.from(radioStations.entries()).map(([id, station]) => {
    const info = station.getCurrentTrackInfo();
    return {
      id,
      name: station.name,
      url: `http://localhost:${PORT}/radio/${id}`,
      ets2Format: `http://localhost:${PORT}/radio/${id}|${station.name}`,
      currentTrack: info.currentTrack,
      progress: info.progressPercent + '%',
      listeners: info.listeners,
      totalTracks: station.files.length
    };
  });

  res.json({
    stations: stationList,
    totalStations: radioStations.size,
    instructions: {
      message: "These are live radio stations - join at current playback position",
      ets2Config: "Add these to your live_streams.sii file:",
      examples: stationList.map(s => `stream_data[]: "${s.ets2Format}"`)
    }
  });
});

// Real-time station status
app.get('/status', (req, res) => {
  const status = Array.from(radioStations.entries()).map(([id, station]) => {
    const info = station.getCurrentTrackInfo();
    return {
      station: station.name,
      ...info
    };
  });

  res.json({
    timestamp: new Date().toISOString(),
    stations: status
  });
});

// Test page with live updates
app.get('/test', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>ETS2 Radio Stations - Live</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          .station { border: 1px solid #ccc; margin: 10px 0; padding: 15px; }
          .progress { background: #f0f0f0; height: 20px; margin: 5px 0; }
          .progress-bar { background: #4CAF50; height: 100%; transition: width 0.5s; }
        </style>
      </head>
      <body>
        <h1>🎵 ETS2 Radio Stations - Live Broadcasting</h1>
        <div id="stations"></div>
        
        <script>
          function updateStatus() {
            fetch('/status')
              .then(r => r.json())
              .then(data => {
                const html = data.stations.map(s => \`
                  <div class="station">
                    <h3>\${s.station}</h3>
                    <p><strong>Now Playing:</strong> \${s.currentTrack}</p>
                    <p><strong>Listeners:</strong> \${s.listeners}</p>
                    <div class="progress">
                      <div class="progress-bar" style="width: \${s.progressPercent}%"></div>
                    </div>
                    <p>Progress: \${s.progressPercent}%</p>
                    <audio controls>
                      <source src="/radio/\${data.stations.indexOf(s) === 0 ? 'rock' : 'chill'}" type="audio/mpeg">
                    </audio>
                  </div>
                \`).join('');
                document.getElementById('stations').innerHTML = html;
              });
          }
          
          updateStatus();
          setInterval(updateStatus, 2000); // Update every 2 seconds
        </script>
      </body>
    </html>
  `);
});

// Initialize stations on startup
initializeStations();

app.listen(PORT, () => {
  console.log(`🎵 ETS2 Live Radio Server running on port ${PORT}`);
  console.log(`📻 Stations: http://localhost:${PORT}/stations`);
  console.log(`📊 Live status: http://localhost:${PORT}/status`);
  console.log(`🧪 Test page: http://localhost:${PORT}/test`);
  console.log(`\n🚛 For ETS2, add stations to live_streams.sii`);
  console.log(`⚠️  Note: Music plays continuously! Join at current position.`);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down radio stations...');
  radioStations.forEach(station => station.stop());
  process.exit(0);
});
