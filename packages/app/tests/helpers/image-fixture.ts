import { crc32, deflateSync } from 'zlib';

function chunk(type: string, data: Buffer) {
	const content = Buffer.concat([Buffer.from(type), data]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(content));
	return Buffer.concat([length, content, checksum]);
}

/** A complete, decodable PNG with uncompressed pixel data, not just a magic header. */
export function imageFixture(width: number, height: number, color = [255, 0, 0]) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	const stride = width * 4 + 1;
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = y * stride + 1 + x * 4;
			pixels[offset] = color[0];
			pixels[offset + 1] = color[1];
			pixels[offset + 2] = color[2];
			pixels[offset + 3] = 255;
		}
	}
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(pixels, { level: 0 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}
