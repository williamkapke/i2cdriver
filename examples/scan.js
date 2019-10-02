const i2cdriver = require('../');
const hex = (v) => v.toString(16).padStart(2, '0')

i2cdriver.open('/dev/tty.usbserial-DO01INSW')
.then(async (device) => {
  console.log((await device.scan()).map(a => '0x'+hex(a).toUpperCase()).join(' '))
})
.catch(console.error)
