import EventEmitter from 'node:events'
import dgram from 'node:dgram'
import { PassThrough } from 'node:stream'

import WebSocket from './ws.js'
import Sodium from './sodium.js'

const nonce = Buffer.alloc(24)
const OPUS_SAMPLE_RATE = 48000
const OPUS_FRAME_DURATION = 20
const OPUS_FRAME_SIZE = OPUS_SAMPLE_RATE * OPUS_FRAME_DURATION / 1000
const TIMESTAMP_INCREMENT = (OPUS_SAMPLE_RATE / 100) * 2
const MAX_NONCE = 2 ** 32 - 1
const MAX_TIMESTAMP = 2 ** 32
const MAX_SEQUENCE = 2 ** 16
const ENCRYPTION_MODE = 'xsalsa20_poly1305_lite'

const adapters = {}
const ssrcs = {}

class Connection extends EventEmitter {
  constructor(obj) {
    super()

    this.guildId = obj.guildId
    this.userId = obj.userId

    this.ws = null

    this.state = {
      status: 'disconnected'
    }
    this.playerState = {
      status: 'idle'
    }

    this.sessionId = null
    this.voiceServer = null

    this.hbInterval = null
    this.udpInfo = null
    this.udp = null

    this.ping = -1

    this.player = {
      sequence: 0,
      timestamp: 0
    }

    this.nonce = 0
    this.nonceBuffer = Buffer.alloc(24)

    this.playInterval = null
    this.audioStream = null

    adapters[`${this.userId}/${this.guildId}`] = this
  }

  udpSend(data) {
    this.udp.send(data, this.udpInfo.port, this.udpInfo.ip)
  }

  _setSpeaking(value) {
    this.ws.send(JSON.stringify({
      op: 5,
      d: {
        speaking: value,
        delay: 0,
        ssrc: this.udpInfo.ssrc
      }
    }))
  }

  _updateState(state) {
    this.emit('stateChange', this.state, state)
    this.state = state
  }

  _updatePlayerState(state) {
    this.emit('playerStateChange', this.playerState, state)
    this.playerState = state
  }

  _ipDiscovery() {
    return new Promise((resolve) => {
      this.udp.once('message', (message) => {
        const data = message.readUInt16BE(0)
        if (data != 2) return;

        const packet = Buffer.from(message)

        resolve({
          ip: packet.subarray(8, packet.indexOf(0, 8)).toString('utf8'),
          port: packet.readUInt16BE(packet.length - 2)
        })
      })

      const discoveryBuffer = Buffer.alloc(74)

      discoveryBuffer.writeUInt16BE(1, 0)
      discoveryBuffer.writeUInt16BE(70, 2)
      discoveryBuffer.writeUInt32BE(this.udp.ssrc, 4)

      this.udpSend(discoveryBuffer)
		})
  }

  connect(cb, reconnection) {
    if (reconnection) this._updateState({ status: 'connecting' })

    this.ws = new WebSocket(`wss://${this.voiceServer.endpoint}/?v=4`, {
      headers: {
        'User-Agent': `PerformanC Voice (https://github.com/PerformanC/voice)`
      }
    })

    this.ws.on('open', () => {
      if (reconnection) {
        this.ws.send(JSON.stringify({
          op: 7,
          d: {
            server_id: this.voiceServer.guildId,
            session_id: this.sessionId,
            token: this.voiceServer.token
          }
        }))
      } else {
        this.ws.send(JSON.stringify({
          op: 0,
          d: {
            server_id: this.voiceServer.guildId,
            user_id: this.userId,
            session_id: this.sessionId,
            token: this.voiceServer.token
          }
        }))
      }
    })

    this.ws.on('message', async (data) => {
      const payload = JSON.parse(data)

      switch (payload.op) {
        case 2: {
          this.udpInfo = {
            ssrc: payload.d.ssrc,
            ip: payload.d.ip,
            port: payload.d.port,
            secretKey: null
          }

          this.udp = dgram.createSocket('udp4')

          this.udp.on('message', (data) => {
            if (data.length <= 8) return;

            const ssrc = data.readUInt32BE(8)
            const userData = ssrcs[ssrc]

            if (!userData) return;

            if (!userData.stream) {
              userData.stream = new PassThrough()

              this.emit('speakStart', userData.userId, ssrc)
            }

            clearTimeout(userData.timeout)

            userData.timeout = setTimeout(() => {
              this.emit('speakEnd', userData.userId, ssrc)

              if (userData) {
                userData.stream.end()
                userData.stream = null
              }
            })
          
            const dataEnd = data.length - 4

            data.copy(this.nonceBuffer, 0, dataEnd)
            const voice = data.subarray(12, dataEnd)

            const output = Sodium.open(voice, this.nonceBuffer, this.udpInfo.secretKey)

            let packet = Buffer.from(output)

            if (packet[0] == 0xbe && packet[1] == 0xde) {
              const headerExtensionLength = packet.readUInt16BE(2)
              packet = packet.subarray(4 + 4 * headerExtensionLength)
            }

            userData.stream.write(packet)
          })

          this.udp.on('error', (error) => this.emit('error', error))

          this.udp.on('close', () => {
            if (!this.ws) return;

            this.destroy()

            this.emit('error', new Error('UDP socket closed unexpectadly.'))
          })

          const serverInfo = await this._ipDiscovery()

          this.ws.send(JSON.stringify({
            op: 1,
            d: {
              protocol: 'udp',
              data: {
                address: serverInfo.ip,
                port: serverInfo.port,
                mode: 'xsalsa20_poly1305_lite'
              }
            }
          }))

          this._updateState({ status: 'ready' })

          break
        }
        case 4: {
          this.udpInfo.secretKey = new Uint8Array(payload.d.secret_key)

          if (cb) cb()

          break
        }
        case 5: {
          ssrcs[payload.d.ssrc] = {
            userId: payload.d.user_id,
            stream: new PassThrough()
          }

          this.emit('speakStart', payload.d.user_id, payload.d.ssrc)

          break
        }
        case 6: {
          this.ping = Date.now() - payload.d

          break
        }
        case 8: {
          this.hbInterval = setInterval(() => {
            this.ws.send(JSON.stringify({
              op: 3,
              d: Date.now()
            }))
          }, payload.d.heartbeat_interval)

          break
        }
      }
    })

    this.ws.on('close', (code) => {
      if (!this.ws) return;

      this.destroy()

      this._updateState({ status: 'disconnected', reason: 'websocketClose', code: code })
      this._updatePlayerState({ status: 'idle' })

      if (code == 4015) {
        this.connect(null, true)
      } else {
        this.emit('error', new Error('WebSocket closed unexpectadly.'))
      }
    })

    this.ws.on('error', (error) => this.emit('error', error))
  }

  sendAudioChunk(packetBuffer, chunk) {
    packetBuffer.writeUInt8(0x80, 0)
    packetBuffer.writeUInt8(0x78, 1)

    packetBuffer.writeUInt16BE(this.player.sequence, 2, 2)
    packetBuffer.writeUInt32BE(this.player.timestamp, 4, 4)
    packetBuffer.writeUInt32BE(this.udpInfo.ssrc, 8, 4)

    packetBuffer.copy(nonce, 0, 0, 12)

    this.player.timestamp += TIMESTAMP_INCREMENT
    if (this.player.timestamp > MAX_TIMESTAMP) this.player.timestamp = 0
    this.player.sequence++
    if (this.player.sequence > MAX_SEQUENCE) this.player.sequence = 0

    switch (ENCRYPTION_MODE) {
      case 'xsalsa20_poly1305_lite': {
        this.nonce++
        if (this.nonce > MAX_NONCE) this.nonce = 0
        this.nonceBuffer.writeUInt32LE(this.nonce, 0)

        const output = Sodium.close(chunk, this.nonceBuffer, this.udpInfo.secretKey)

        this.udpSend(Buffer.concat([packetBuffer, output, this.nonceBuffer.subarray(0, 4) ]))

        break
      }
      case 'xsalsa20_poly1305_suffix': {
        const random = Sodium.random(24, this.nonceBuffer)
        const output = Sodium.close(chunk, random, this.udpInfo.secretKey)

        this.udpSend(Buffer.concat([packetBuffer, output, random ]))

        break
      }
      case 'xsalsa20_poly1305': {
        const output = Sodium.close(chunk, nonce, this.udpInfo.secretKey)

        this.udpSend(Buffer.concat([packetBuffer, output ]))

        break
      }
      case 'aead_aes256_gcm': {
        const output = Sodium.close(chunk, nonce, this.udpInfo.secretKey)

        this.udpSend(Buffer.concat([packetBuffer, output ]))

        break
      }
    }
  }

  play(audioStream) {
    if (!this.udpInfo) {
      this.emit('error', new Error('Cannot play audio without UDP info.'))

      return;
    }

    this._setSpeaking(1 << 0)

    audioStream.once('readable', () => {
      if (this.audioStream) {
        this.audioStream = audioStream

        return;
      }

      this.audioStream = audioStream

      this._updatePlayerState({ status: 'playing' })

      const packetBuffer = Buffer.allocUnsafe(12)

      this.playInterval = setInterval(() => {
        if (!this.audioStream || this.state.status != 'ready') return this.stop()

        const chunk = this.audioStream.read(OPUS_FRAME_SIZE)

        if (!chunk || this.state.status == 'idle') return this.stop()

        this.sendAudioChunk(packetBuffer, chunk)
      }, OPUS_FRAME_DURATION)
    })
  }

  stop() {
    clearInterval(this.playInterval)
    this.audioStream.resume()
    this.audioStream = null

    this._updatePlayerState({ status: 'idle' })

    this.udpSend(Buffer.from([ 0xF8, 0xFF, 0xFE ]))
    this._setSpeaking(0)
  }

  pause() {
    this._updatePlayerState({ status: 'paused' })

    this._setSpeaking(0)
    clearInterval(this.playInterval)
  }

  unpause() {
    this._updatePlayerState({ status: 'playing' })

    this._setSpeaking(1 << 0)

    const packetBuffer = Buffer.allocUnsafe(12)

    this.playInterval = setInterval(() => {
      if (!this.audioStream || this.state.status != 'ready') return this.stop()

      const chunk = this.audioStream.read(OPUS_FRAME_SIZE)

      if (!chunk || this.state.status == 'idle') return this.stop()

      this.sendAudioChunk(packetBuffer, chunk)
    }, OPUS_FRAME_DURATION)
  }

  destroy() {
    if (this.ws) this.ws.close()
    if (this.udp) this.udp.close()

    this.ws = null
    this.udp = null

    this.udpInfo = null
    this.voiceServer = null
    this.sessionId = null
    if (this.audioStream) this.audioStream.resume()
    this.audioStream = null

    this._updateState({ status: 'destroyed' })
    this._updatePlayerState({ status: 'idle' })

    clearInterval(this.hbInterval)
    clearInterval(this.playInterval)

    delete adapters[`${this.userId}/${this.guildId}`]
  }
}

function joinVoiceChannel(obj) {
  return new Connection(obj)
}

function voiceStateUpdate(obj) {
  const connection = adapters[`${obj.user_id}/${obj.guild_id}`]

  if (!connection) return

  connection.sessionId = obj.session_id
}

function voiceServerUpdate(obj) {
  const connection = adapters[`${obj.user_id}/${obj.guild_id}`]

  if (!connection) return;

  connection.voiceServer = {
    token: obj.token,
    guildId: obj.guild_id,
    endpoint: obj.endpoint
  }

  if (!connection.ws) connection._updateState({ status: 'connecting' })
}

function getSpeakStream(ssrc) {
  return ssrcs[ssrc]?.stream
}

export default {
  joinVoiceChannel,
  voiceStateUpdate,
  voiceServerUpdate,
  getSpeakStream
}