/**
 * Minimal authoritative DNS server over UDP for tests (TXT, CNAME, A).
 * Unknown names answer NXDOMAIN (→ ENOTFOUND); known names without the asked type answer
 * NOERROR with no records (→ ENODATA). Point resolvers at it with `dns.setServers`.
 */

import dgram from "node:dgram";

export interface StubRecords {
  TXT?: string[];
  CNAME?: string;
  A?: string[];
}

const TYPE = { A: 1, CNAME: 5, TXT: 16 } as const;

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, "").split(".").filter(Boolean);
  return Buffer.concat([...parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])), Buffer.from([0])]);
}

function rr(type: number, rdata: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0xc00c, 0); // pointer to the question name
  head.writeUInt16BE(type, 2);
  head.writeUInt16BE(1, 4); // IN
  head.writeUInt32BE(30, 6); // TTL
  head.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([head, rdata]);
}

export async function startDnsStub(port: number, zone: Map<string, StubRecords>): Promise<{ queries: string[]; close: () => Promise<void> }> {
  const socket = dgram.createSocket("udp4");
  const queries: string[] = [];

  socket.on("message", (msg, rinfo) => {
    let off = 12;
    const labels: string[] = [];
    while (msg[off] !== 0 && off < msg.length) {
      const len = msg[off];
      labels.push(msg.subarray(off + 1, off + 1 + len).toString());
      off += len + 1;
    }
    off += 1;
    const qtype = msg.readUInt16BE(off);
    const question = msg.subarray(12, off + 4);
    const name = labels.join(".").toLowerCase();
    queries.push(`${name}/${qtype}`);

    const records = zone.get(name);
    const answers: Buffer[] = [];
    if (records) {
      if (qtype === TYPE.TXT) {
        for (const txt of records.TXT || []) answers.push(rr(TYPE.TXT, Buffer.concat([Buffer.from([txt.length]), Buffer.from(txt)])));
      } else if (qtype === TYPE.CNAME && records.CNAME) {
        answers.push(rr(TYPE.CNAME, encodeName(records.CNAME)));
      } else if (qtype === TYPE.A) {
        for (const ip of records.A || []) answers.push(rr(TYPE.A, Buffer.from(ip.split(".").map(Number))));
      }
    }

    const header = Buffer.alloc(12);
    msg.copy(header, 0, 0, 2); // id
    header.writeUInt16BE(records ? 0x8580 : 0x8583, 2); // QR AA RD RA, rcode 0 / 3 (NXDOMAIN)
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answers.length, 6);
    socket.send(Buffer.concat([header, question, ...answers]), rinfo.port, rinfo.address);
  });

  await new Promise<void>((resolve) => socket.bind(port, "127.0.0.1", resolve));
  return { queries, close: () => new Promise((r) => socket.close(() => r())) };
}
