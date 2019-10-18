const DefaultBindings = require('@serialport/bindings')
const dbg = require('debug')
const debug = dbg('i2cdriver')
const debug_command = debug.extend('command')

const hex = (v) => v.toString(16).padStart(2, '0')
dbg.formatters.h = (v) => v.length ? Array.prototype.map.call(v, b => hex(b)).join(' ') : hex(v)
dbg.formatters.b = (v) => v.toString(2)

const ok = () => Promise.resolve()
const fail = (msg) => Promise.reject(new Error(msg))
const cmd = {
  '?': Buffer.alloc(1, '?'), // transmit status info
  'e': Buffer.alloc(2, 'e'), // byte echo byte
  '1': Buffer.alloc(1, '1'), // set speed to 100 KHz
  '4': Buffer.alloc(1, '4'), // set speed to 400 KHz
  's': Buffer.alloc(2, 's'), // addr send START/addr, return status
  // 0x80-bf read 1-64 bytes, NACK the final byte
  // 0xc0-ff write 1-64 bytes
  'a': Buffer.alloc(2, 'a'), // N read N bytes, ACK every byte
  'P': Buffer.alloc(1, 'P'), // send STOP
  'x': Buffer.alloc(1, 'P'), // reset I2C bus
  'r': Buffer.alloc(1, 'P'), // register read
  'd': Buffer.alloc(1, 'd'), // scan devices, return 112 status bytes
  'm': Buffer.alloc(1, 'm'), // enter monitor mode
  '@': Buffer.alloc(1, '@'), // exit monitor mode
  'c': Buffer.alloc(1, 'c'), // enter capture mode
  'b': Buffer.alloc(1, 'b'), // enter bitbang mode
  'i': Buffer.alloc(1, 'i'), // leave bitmang, return to I2C mode
  'u': Buffer.alloc(2, 'u'), // byte set pullup control lines
  'v': Buffer.alloc(1, 'v'), // start analog voltage measurement
  'w': Buffer.alloc(1, 'w'), // read voltage measurement result
}
const i2cFuncs = {
  i2c: true,
  tenBitAddr: false,
  protocolMangling: false,
  smbusPec: false,
  smbusBlockProcCall: true,
  smbusQuick: false,
  smbusReceiveByte: true,
  smbusSendByte: true,
  smbusReadByte: true,
  smbusWriteByte: true,
  smbusReadWord: true,
  smbusWriteWord: true,
  smbusProcCall: false,
  smbusReadBlock: true,
  smbusWriteBlock: true,
  smbusReadI2cBlock: true,
  smbusWriteI2cBlock: true,
}
const opened = {}

const open = async (path, baudRate=1000000) => {
  const port = opened[path] || new DefaultBindings({})
  if(!port.isOpen) {
    await port.open(path, {baudRate})
    opened[path] = port
  }

  const write = async (data) => {
    if (!port.isOpen) {
      debug('read: port is closed')
      return Promise.reject(new Error('attempt to read from closed port'))
    }
    debug('write length=%s [%h]', data.length, data)
    await port.write(data)
  }
  const writeAndDrain = async (data) => {
    await write(data)
    return port.drain()
  }

  const read = async (size) => {
    if (!port.isOpen) {
      debug('read: port is closed')
      return Promise.reject(new Error('attempt to read from closed port'))
    }
    const buff = Buffer.allocUnsafe(size)
    let offset = 0
    try {
      while(true) {
        offset += await port.read(buff, offset, size - offset)
        if (offset===size) break
      }
    }
    catch (e) {
      debug('error reading from serial', e)
      return Promise.reject(e)
    }

    debug('read(%s): [%h]', size, buff)
    return buff
  }

  // reads a byte and looks at the right most: 1 = success
  const ack = async () => ((await read(1))[0] & 1) === 1

  // const echo = async (byte) => {
  //   if (typeof byte === 'string') {
  //     byte = byte.charCodeAt(0)
  //   }
  //   cmd['e'][1] = byte
  //   await writeAndDrain(cmd['e'])
  //   return read(1)
  // }

  const iface = {
    close: port.close,
    setspeed: async (speed) => {
      spped = parseInt(speed, 10)
      if (speed === 100) return writeAndDrain(cmd['1'])
      if (speed === 400) return writeAndDrain(cmd['4'])
      throw new Error('Unsupported speed: ' + (speed || ''))
    },
    setpullups: async (mask) => {
      if (!mask || typeof mask !== 'number' || mask > 0b111111) {
        throw new Error('Invalid pullup mask: ' + (mask || ''))
      }
      debug_command('x 0b%b', mask)
      cmd.u[1] = mask
      return writeAndDrain(cmd.u)
    },
    scan: async () => {
      await writeAndDrain(cmd.d)
      const result = (await read(112)).toString()
      return result.split('').map((n,i)=>Number(n)?i+8:null).filter(Boolean)
    },
    reset: () => {
      debug_command('x')
      return writeAndDrain(cmd.x)
    },
    start: async (addr, rw = 0) => {
      if (rw === 'write') rw = false
      const buff = cmd.s
      buff[1] = addr << 1 | Number(Boolean(rw))
      debug_command('s 0x%h', buff[1])
      await writeAndDrain(buff)
      return (await ack()) ? ok() : fail('start command failed to 0x' + hex(addr))
    },
    read: async (length) => {
      // fast path
      if (!length) return true
      if (length <= 64) {
        debug_command('0x%h', length)
        await writeAndDrain(Buffer.alloc(1, 0x7f + length))
        return read(length)
      }

      //chunked - only works if device tracks a read cursor
      const result = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i+=64) {
        const n = Math.min(length - i, 64);
        debug_command('0x%h', n, i, length - i)
        await writeAndDrain(Buffer.alloc(1, 0x7f + n))
        const buff = await read(n)
        buff.copy(result, i)
      }
      return result
    },
    write: async (buff) => {
      // fastpath
      if (!buff.length) return true
      if (buff.length <= 64) {
        const command = 0xbf + buff.length;
        debug_command('0x%h %h', command, buff)
        await write(Buffer.alloc(1, command))
        await writeAndDrain(buff)
        return (await ack()) ? ok() : fail('write command failed')
      }

      //chunked
      for (let i = 0; i < buff.length; i += 64) {
        const slice = buff.subarray(i, i+64)
        const command = 0xbf + slice.length;
        debug_command('0x%h %h', command, slice)
        await write(Buffer.alloc(1, command))
        await writeAndDrain(slice)
        if (!await ack()) return fail('write command failed')
      }
    },
    stop: async () => {
      debug_command('P')
      await writeAndDrain(cmd.P)
    },
    regrd: async (addr, register, length = 1) => {
      if (!Array.isArray(register)) register = [register]
      if (length <= 64) {
        //fast path
        await iface.start(addr, 'write')
        await iface.write(Buffer.from(register))
        await iface.start(addr, 'read')
        const result = await iface.read(length)
        await iface.stop()
        return result
      }

      const size = register.length // how many bytes is this register?
      register = Buffer.from(register)

      //we need the register as a number so we can increment it
      let index = parseInt(register.toString('hex'), 16)

      const result = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i+=64) {
        index += i
        await iface.start(addr, 'write')
        await iface.write(Buffer.from(index.toString(16).padStart(size * 2, '0'), 'hex'))

        await iface.start(addr, 'read')
        const n = Math.min(length - i, 64);
        const buff = await iface.read(n)
        buff.copy(result, i)

        await iface.stop()
      }

      return result
    },
    regwr: async (addr, register, value) => {
      if (!Array.isArray(value)) value = [value]
      value.unshift(register)
      await iface.start(addr, 'write')
      await iface.write(Buffer.from(value))
      await iface.stop()
    },
    monitor: (start=true) => {
      // debug_command('x')
      // return writeAndDrain(start? cmd.m : cmd['@'])
      throw new Error('Not Implemented')
    },
    status: async () => {
      debug_command('?')
      await write(cmd['?'])
      const info = (await read(80)).toString()

      if (!info || info.length !== 80) {
        throw new Error('Invalid response from device'+ info)
      }
      const parts = info.substr(1).split(' ')
      return {
        identifier: parts[0],
        serial: parts[1],
        uptime: parseInt(parts[2], 10),
        voltage: parseFloat(parts[3]),
        current: parseFloat(parts[4]),
        temperature: parseFloat(parts[5]),
        mode: parts[6],
        SDA: Number(parts[7]),
        SCL: Number(parts[8]),
        speed: parseInt(parts[9], 10),
        pullups: parseInt(parts[10], 16),
        crc: parseInt(parts[11], 16)
      }
    },

    get 'i2c-bus-promise'() { return i2c_bus_promisified(iface) }
  }


  // initialize/reset
  await writeAndDrain(Buffer.alloc(1, 0x40))
  await iface.reset()
  await writeAndDrain(Buffer.alloc(64, 0x40))
  await iface.reset()
  debug('scan: [%h]', await iface.scan())
  await iface.setspeed(400)

  debug('initialize complete')


  return iface
}

// An i2cdriver API does not have a mechanism to mimic/enforce "only one at a time"
// communication like a real i2c bus. So- we need to create one of our own...
let promiseAtEndOfTheLine = Promise.resolve();
const waitMyTurn = (fn) => (
  promiseAtEndOfTheLine = new Promise(async (resolve, reject) => {
    try {
      await promiseAtEndOfTheLine
    }
    catch(e) {}

    fn().then(resolve).catch(reject)
  })
)

// An API that allows the i2cdriver to be used in place of the `i2c-bus` module
const i2c_bus_promisified = (device) => {
  const i2c_bus_promise_iface = {
    // We just need something things to make it compatible
    //   with existing checks for a promisified version.
    _bus: true, // Ideally- an accessor for a non-promise version will go here.
    wrapped: true,

    // allow access to the device
    get i2cdriver() { return device },

    close: device.close,
    i2cFuncs: () => new Promise((resolve) => resolve(i2cFuncs)),
    scan: async (start = 0x03, end = 0x77) => {
      const addrs = await device.scan()
      return addrs.filter(n => n > start && n < end)
    },
    deviceId: (addr) => {
      throw new Error('Not Implemented')
    },
    i2cRead: (addr, length, buffer) => waitMyTurn(async () => {
      await device.start(addr, 'read')
      const response = await device.read(length)
      await device.stop()

      response.copy(buffer)
      return {
        bytesRead: length,
        buffer
      }
    }),
    i2cWrite: (addr, length, buffer) => waitMyTurn(async () => {
      if (length !== buffer.length) {
        buffer = buffer.subarray(0, length)
      }
      await device.start(addr, 'write')
      await device.write(buffer)
      await device.stop()
      return {
        bytesWritten: length,
        buffer
      }
    }),

    //SMBus
    readByte: (addr, cmd) => waitMyTurn(async () => {
      checkCmd(cmd)
      return device.regrd(addr, cmd, 1)
    }),

    readWord: (addr, cmd) => waitMyTurn(() => {
      checkCmd(cmd)
      return device.regrd(addr, cmd, 2)
    }),

    readI2cBlock: async (addr, cmd, length, buffer) => {
      checkCmd(cmd)

      const buff = await device.readChunked(addr, cmd, length)
      buff.copy(buffer)
      return {
        bytesRead: length,
        buffer
      }
    },

    receiveByte: async (addr) => {
      return (await i2c_bus_promise_iface.i2cRead(addr, 1, Buffer.allocUnsafe(1))).buffer[0]
    },

    sendByte: async (addr, byte) => {
      return i2c_bus_promise_iface.i2cWrite(addr, 1, Buffer.alloc(1, byte))
    },

    writeByte: (addr, cmd, byte) => waitMyTurn(async () => {
      checkCmd(cmd)
      return device.regwr(addr, cmd, byte)
    }),

    writeWord: (addr, cmd, word) => waitMyTurn(() => {
      checkCmd(cmd)
      return device.regwr(addr, cmd, [word >> 8, word & 0xFF])
    }),

    // This sends a single bit to the device, at the place of the Rd/Wr bit.
    // serialport only supports sending bytes... not sure how to implement this
    writeQuick: (addr, bit) => {
      throw new Error('Not Implemented')
    },

    writeI2cBlock: (addr, cmd, length, buffer) => waitMyTurn(async () => {
      checkCmd(cmd)
      if (length !== buffer.length) {
        buffer = buffer.subarray(0, length)
      }
      const buff = Buffer.allocUnsafe(length + 1, cmd)
      buffer.copy(buff, 1)
      return device.regwr(addr, cmd, buff)
    })
  }
  return i2c_bus_promise_iface
}
const checkCmd = (cmd) => {
  if (typeof cmd !== 'number' || cmd > 0xFF) {
    throw new Error('Invalid I2C command')
  }
}
const SyncNotImplemented = () => {
  throw new Error('Sync functions are not implemented by the i2cdriver module')
}

module.exports = {
  open,
  // convenience API to make code more swappable with the i2c-bus module.
  'i2c-bus': {
    open: (port, options, cb) => {
      if (typeof options === 'function') cb = options

      let bus;
      const initialize = module.exports['i2c-bus'].openPromisified(port).then((b) => {
        bus = b
      })

      // proxy all external calls through this to make them wait until init is done
      const whenReady = (fn) => async (...args) => {
        await initialize // wait until the initialize promise is resolved
        // now update the iface to reference the function directly
        // so we don't have the overhead of doing this every time
        i2c_bus_iface[fn.name] = fn
        return fn.apply(fn, args)
      }

      const i2c_bus_iface = {
        close: whenReady((cb) => {
          bus.close().then(cb, cb)
        }),
        i2cFuncs: () => bus.i2cFuncs().then(cb),
        i2cFuncsSync: () => i2cFuncs,
        scan: whenReady((start, end, cb) => {
          if (typeof start === 'function') {
            cb = start;
            start = undefined;
            end = undefined;
          }
          else if (typeof end === 'function') {
            cb = end;
            end = undefined;
          }

          bus.scan(start, end)
          .then((addrs) => cb(null, addrs))
          .catch(cb)
        }),
        deviceId: whenReady((addr, cb) => {
          bus.deviceId(addr)
          .then((id) => cb(null, id))
          .catch(cb)
        }),
        i2cRead: whenReady((addr, length, buffer, cb) => {
          bus.i2cRead(addr, length, buffer)
          .then((result) => cb(null, result.bytesRead, result.buffer))
          .catch(cb)
        }),
        i2cWrite: whenReady((addr, length, buffer, cb) => {
          bus.i2cWrite(addr, length, buffer)
          .then((result) => cb(null, result.bytesWritten, result.buffer))
          .catch(cb)
        }),
        readByte: whenReady((addr, cmd, cb) => {
          bus.readByte(addr, cmd)
          .then((byte) => cb(null, byte))
          .catch(cb)
        }),
        readWord: whenReady((addr, cmd, cb) => {
          bus.readWord(addr, cmd)
          .then((word) => cb(null, word))
          .catch(cb)
        }),
        readI2cBlock: whenReady((addr, cmd, length, buffer, cb) => {
          bus.readI2cBlock(addr, cmd, length, buffer)
          .then((result) => cb(null, result.bytesRead, result.buffer))
          .catch(cb)
        }),
        receiveByte: whenReady((addr, cb) => {
          bus.receiveByte(addr)
          .then((byte) => cb(null, byte))
          .catch(cb)
        }),
        sendByte: whenReady((addr, byte, cb) => {
          bus.sendByte(addr, byte)
          .then(cb, cb)
        }),
        writeByte: whenReady((addr, cmd, byte, cb) => {
          bus.writeByte(addr, cmd, byte)
          .then(cb, cb)
        }),
        writeWord: whenReady((addr, cmd, word, cb) => {
          bus.writeWord(addr, cmd, word)
          .then(cb, cb)
        }),
        writeQuick: whenReady((addr, bit, cb) => {
          bus.writeQuick(addr, bit)
          .then(cb, cb)
        }),
        writeI2cBlock: whenReady((addr, cmd, length, buffer, cb) => {
          bus.writeI2cBlock(addr, cmd, length, buffer)
          .then((result) => cb(null, result.bytesWritten, result.buffer))
          .catch(cb)
        }),

        closeSync: SyncNotImplemented,
        scanSync: SyncNotImplemented,
        deviceIdSync: SyncNotImplemented,
        i2cReadSync: SyncNotImplemented,
        i2cWriteSync: SyncNotImplemented,
        readByteSync: SyncNotImplemented,
        readWordSync: SyncNotImplemented,
        readI2cBlockSync: SyncNotImplemented,
        receiveByteSync: SyncNotImplemented,
        sendByteSync: SyncNotImplemented,
        writeByteSync: SyncNotImplemented,
        writeWordSync: SyncNotImplemented,
        writeQuickSync: SyncNotImplemented,
        writeI2cBlockSync: SyncNotImplemented,
      }

      setImmediate(cb, null)

      return i2c_bus_iface
    },
    openSync: SyncNotImplemented,
    openPromisified: async (port) => {
      const device = await module.exports.open(port)
      return i2c_bus_promisified(device)
    }
  }
}

