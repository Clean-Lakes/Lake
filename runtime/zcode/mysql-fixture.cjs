async function mysqlServer(t, handler) {
  const queries = [],
    clients = new Set(),
    net = require("node:net");
  const u16 = (n) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n & 65535);
    return b;
  };
  const str = (value) => {
    if (value == null) return Buffer.from([251]);
    const b = Buffer.from(String(value));
    if (b.length < 251) return Buffer.concat([Buffer.from([b.length]), b]);
    const h = Buffer.alloc(4);
    h[0] = 253;
    h.writeUIntLE(b.length, 1, 3);
    return Buffer.concat([h, b]);
  };
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
    let buffer = Buffer.alloc(0),
      authenticated = false;
    const packet = (sequence, payload) => {
      const h = Buffer.alloc(4);
      h.writeUIntLE(payload.length, 0, 3);
      h[3] = sequence;
      socket.write(Buffer.concat([h, payload]));
    };
    const ok = Buffer.from([0, 0, 0, 2, 0, 0, 0]),
      caps = 1 | 4 | 8 | 512 | 8192 | 32768 | (1 << 17) | (1 << 19);
    packet(
      0,
      Buffer.concat([
        Buffer.from("\x0a8.0.36-fixture\0"),
        Buffer.from([1, 0, 0, 0]),
        Buffer.from("12345678\0"),
        u16(caps),
        Buffer.from([45, 2, 0]),
        u16(caps >>> 16),
        Buffer.from([21]),
        Buffer.alloc(10),
        Buffer.from("abcdefghijkl\0mysql_native_password\0"),
      ]),
    );
    const connection = {
      destroy: () => socket.destroy(),
      writeOk: () => packet(1, ok),
      writeTextResult: (rows, fields) => {
        let sequence = 1;
        packet(sequence++, Buffer.from([fields.length]));
        for (const f of fields)
          packet(
            sequence++,
            Buffer.concat(
              ["def", "", "", "", f.name, f.name]
                .map(str)
                .concat([
                  Buffer.from([12, 45, 0, 255, 255, 0, 0, 253, 0, 0, 0, 0, 0]),
                ]),
            ),
          );
        packet(sequence++, Buffer.from([254, 0, 0, 2, 0]));
        for (const row of rows)
          packet(
            sequence++,
            Buffer.concat(fields.map((f) => str(row[f.name]))),
          );
        packet(sequence++, Buffer.from([254, 0, 0, 2, 0]));
      },
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUIntLE(0, 3);
        if (buffer.length < size + 4) return;
        const data = buffer.subarray(4, 4 + size);
        buffer = buffer.subarray(4 + size);
        if (!authenticated) {
          authenticated = true;
          packet(2, ok);
          continue;
        }
        if (data[0] === 1) {
          socket.end();
          return;
        }
        if (data[0] !== 3) {
          socket.destroy();
          return;
        }
        const sql = data.subarray(1).toString();
        queries.push(sql);
        if (/^SET SESSION|^START TRANSACTION|^ROLLBACK/.test(sql))
          connection.writeOk();
        else if (handler) handler(connection, sql);
        else
          connection.writeTextResult(
            [{ name: "fixture_database" }],
            [{ name: "name" }],
          );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of clients) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, queries };
}

module.exports = { mysqlServer };
