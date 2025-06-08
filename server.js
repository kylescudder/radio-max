const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 8080;
const AUDIO_DIR = './audio';

app.use(cors());

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`📡 ${new Date().toISOString()} - ${req.method} ${req.url}`);
  console.log(`   Headers:`, {
    'user-agent': req.headers['user-agent'],
    'accept': req.headers['accept'],
    'range': req.headers['range'],
    'connection': req.headers['connection'],
    'icy-metadata': req.headers['icy-metadata']
  });
  next();
});

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
    this.chunkSize = 1024;
    this.startTime = Date.now();
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

      const endPosition = Math.min(
        this.currentPosition + this.chunkSize, 
        this.fileSize
      );
      
      const chunk = this.currentBuffer.slice(this.currentPosition, endPosition);
      
      // Send chunk to all connected clients
      this.clients.forEach(client => {
        if (!client.res.destroyed && !client.res.writableEnded) {
          try {
            client.res.write(chunk);
          } catch (error) {
            console.log(`❌ Client ${client.id} disconnected during broadcast`);
            this.clients.delete(client);
          }
        } else {
          console.log(`🔌 Removing dead client ${client.id}`);
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

  addClient(client) {
    this.clients.add(client);
    
    // Detect client type
    const userAgent = client.userAgent || 'Unknown';
    const clientType = userAgent.includes('ETS2') ? 'ETS2' : 
                      userAgent.includes('Mozilla') ? 'Browser' : 'Other';
    
    console.log(`🎧 NEW CLIENT CONNECTED to ${this.name}:`);
    console.log(`   ID: ${client.id}`);
    console.log(`   Type: ${clientType}`);
    console.log(`   User-Agent: ${userAgent}`);
    console.log(`   Total clients: ${this.clients.size}`);
    
    // Send appropriate headers based on client
    if (client.icyMetadata === '1' || clientType === 'ETS2') {
      this.sendIcyHeaders(client.res);
    } else {
      this.sendHttpHeaders(client.res);
    }
    
    // Send current audio position
    if (this.currentBuffer && this.currentPosition < this.fileSize) {
      const remainingAudio = this.currentBuffer.slice(this.currentPosition);
      try {
        client.res.write(remainingAudio);
      } catch (error) {
        console.log(`❌ Error sending initial audio to client ${client.id}`);
        this.clients.delete(client);
      }
    }
  }

  removeClient(client) {
    this.clients.delete(client);
    console.log(`👋 Client ${client.id} disconnected from ${this.name} (${this.clients.size} remaining)`);
  }

  sendIcyHeaders(res) {
    const currentFile = this.files[this.currentFileIndex];
    const trackName = currentFile.replace('.mp3', '').replace(/[_-]/g, ' ');
    
    const headers = [
      'ICY 200 OK',
      'icy-notice1: ETS2 Custom Radio Server',
      'icy-notice2: Streaming for Euro Truck Simulator 2',
      `icy-name: ${this.name}`,
      'icy-genre: Gaming Music',
      'icy-url: https://radio-max.kylescudder.co.uk',
      'icy-br: 128',
      'icy-sr: 44100',
      'icy-pub: 1',
      'icy-metaint: 16000',
      `icy-description: ${this.name} - Now Playing: ${trackName}`,
      'Content-Type: audio/mpeg',
      'Cache-Control: no-cache, no-store',
      'Connection: close',
      'Accept-Ranges: none',
      '',
      ''
    ].join('\r\n');

    console.log(`📤 Sending ICY headers to client`);
    res.write(headers);
  }

  sendHttpHeaders(res) {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'close',
      'Accept-Ranges': 'none',
      'Access-Control-Allow-Origin': '*',
      'icy-name': this.name,
      'icy-br': '128'
    });
  }

  getCurrentTrackInfo() {
    const currentFile = this.files[this.currentFileIndex];
    const progressPercent = this.fileSize > 0 ? 
      ((this.currentPosition / this.fileSize) * 100).toFixed(1) : '0';
    
    return {
      currentTrack: currentFile,
      position: this.currentPosition,
      fileSize: this.fileSize,
      progressPercent: progressPercent,
      listeners: this.clients.size,
      uptime: Math.floor((Date.now() - this.startTime) / 1000)
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

  // Create main station with all files
  const mainStation = new RadioStation('RadioMax', mp3Files);
  radioStations.set('main', mainStation);
  mainStation.start();

  console.log(`🎵 Created station 'main' with ${mp3Files.length} tracks`);
}

// Handle HEAD requests (ETS2 often checks streams first)
app.head('/radio/:stationId', (req, res) => {
  console.log(`🔍 HEAD request for station: ${req.params.stationId}`);
  const station = radioStations.get(req.params.stationId);
  
  if (!station) {
    return res.status(404).end();
  }

  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'icy-name': station.name,
    'icy-br': '128',
    'icy-sr': '44100',
    'icy-genre': 'Gaming Music',
    'Accept-Ranges': 'none',
    'Cache-Control': 'no-cache'
  });
  
  res.end();
});

// Main streaming endpoint
app.get('/radio/:stationId', (req, res) => {
  const stationId = req.params.stationId;
  const station = radioStations.get(stationId);

  if (!station) {
    console.log(`❌ Station not found: ${stationId}`);
    return res.status(404).send('Station not found');
  }

  const clientId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const client = { 
    res, 
    id: clientId,
    userAgent: req.headers['user-agent'] || 'Unknown',
    icyMetadata: req.headers['icy-metadata'],
    connectTime: new Date().toISOString()
  };

  station.addClient(client);

  req.on('close', () => {
    station.removeClient(client);
  });

  req.on('aborted', () => {
    station.removeClient(client);
  });

  // Keep connection alive
  req.on('error', (error) => {
    console.log(`❌ Request error for client ${clientId}:`, error.message);
    station.removeClient(client);
  });
});

// Station status with detailed client info
app.get('/stations', (req, res) => {
  const stationList = Array.from(radioStations.entries()).map(([id, station]) => {
    const info = station.getCurrentTrackInfo();
    return {
      id,
      name: station.name,
      url: `https://radio-max.kylescudder.co.uk/radio/${id}`,
      ets2Format: `https://radio-max.kylescudder.co.uk/radio/${id}|${station.name}|GB|128|0|1`,
      currentTrack: info.currentTrack,
      progress: info.progressPercent + '%',
      listeners: info.listeners,
      totalTracks: station.files.length,
      uptime: info.uptime + 's'
    };
  });

  res.json({
    stations: stationList,
    totalStations: radioStations.size,
    serverTime: new Date().toISOString()
  });
});

// Live client monitoring
app.get('/clients', (req, res) => {
  const clientInfo = Array.from(radioStations.entries()).map(([id, station]) => {
    const clients = Array.from(station.clients).map(client => ({
      id: client.id,
      userAgent: client.userAgent,
      connectTime: client.connectTime,
      active: !client.res.destroyed
    }));
    
    return {
      stationId: id,
      stationName: station.name,
      clientCount: clients.length,
      clients: clients
    };
  });

  res.json({
    timestamp: new Date().toISOString(),
    totalClients: clientInfo.reduce((sum, station) => sum + station.clientCount, 0),
    stations: clientInfo
  });
});

// Enhanced test page
app.get('/test', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>RadioMax - Live Monitoring</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
          .station { background: white; border-radius: 8px; margin: 15px 0; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .progress { background: #e0e0e0; height: 8px; border-radius: 4px; margin: 10px 0; }
          .progress-bar { background: #2196F3; height: 100%; border-radius: 4px; transition: width 0.5s; }
          .clients { background: #f8f9fa; padding: 10px; border-radius: 4px; margin: 10px 0; }
          .client { background: white; margin: 5px 0; padding: 8px; border-radius: 4px; font-size: 12px; }
          .live { color: #4CAF50; font-weight: bold; }
        </style>
      </head>
      <body>
        <h1>📻 RadioMax - Live Broadcasting</h1>
        <p class="live">🔴 LIVE - Updates every 2 seconds</p>
        <div id="stations"></div>
        <div id="clients"></div>
        
        <script>
          function updateStatus() {
            Promise.all([
              fetch('/stations').then(r => r.json()),
              fetch('/clients').then(r => r.json())
            ]).then(([stations, clients]) => {
              // Update stations
              const stationsHtml = stations.stations.map(s => \`
                <div class="station">
                  <h3>🎵 \${s.name}</h3>
                  <p><strong>Now Playing:</strong> \${s.currentTrack}</p>
                  <p><strong>Listeners:</strong> \${s.listeners} | <strong>Uptime:</strong> \${s.uptime}</p>
                  <div class="progress">
                    <div class="progress-bar" style="width: \${s.progress}"></div>
                  </div>
                  <p>Progress: \${s.progress}</p>
                  <p><strong>ETS2 URL:</strong> <code>\${s.ets2Format}</code></p>
                </div>
              \`).join('');
              
              // Update clients
              const clientsHtml = \`
                <div class="station">
                  <h3>👥 Connected Clients (\${clients.totalClients} total)</h3>
                  \${clients.stations.map(station => \`
                    <div class="clients">
                      <strong>\${station.stationName}: \${station.clientCount} clients</strong>
                      \${station.clients.map(client => \`
                        <div class="client">
                          ID: \${client.id} | Agent: \${client.userAgent} | Connected: \${new Date(client.connectTime).toLocaleTimeString()}
                        </div>
                      \`).join('')}
                    </div>
                  \`).join('')}
                </div>
              \`;
              
              document.getElementById('stations').innerHTML = stationsHtml;
              document.getElementById('clients').innerHTML = clientsHtml;
            });
          }
          
          updateStatus();
          setInterval(updateStatus, 2000);
        </script>
      </body>
    </html>
  `);
});

initializeStations();

app.listen(PORT, () => {
  console.log(`🎵 RadioMax Server running on port ${PORT}`);
  console.log(`📻 Station info: https://radio-max.kylescudder.co.uk/stations`);
  console.log(`👥 Client monitor: https://radio-max.kylescudder.co.uk/clients`);
  console.log(`🧪 Test page: https://radio-max.kylescudder.co.uk/test`);
  console.log(`\n🚛 ETS2 URL Format:`);
  console.log(`stream_data[]: "https://radio-max.kylescudder.co.uk/radio/main|RadioMax|GB|128|0|1"`);
  console.log(`\n📡 Server will log all incoming requests...`);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down RadioMax...');
  radioStations.forEach(station => station.stop());
  process.exit(0);
});
