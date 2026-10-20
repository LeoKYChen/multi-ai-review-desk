import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { extractDocxText, MAX_DOCX_BYTES } from '../src/docx.mjs';
function zipDocx(xml,compress=true) {
 const name=Buffer.from('word/document.xml');const raw=Buffer.from(xml);const data=compress?deflateRawSync(raw):raw;
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(compress?8:0,8);local.writeUInt32LE(data.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(name.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(compress?8:0,10);central.writeUInt32LE(data.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(name.length,28);
 const eocd=Buffer.alloc(22);eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(1,8);eocd.writeUInt16LE(1,10);eocd.writeUInt32LE(central.length+name.length,12);eocd.writeUInt32LE(local.length+name.length+data.length,16);
 return Buffer.concat([local,name,data,central,name,eocd]);
}
const xml='<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>第一段 &amp; 修正</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>欄一</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>欄二</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>完畢</w:t></w:r></w:p></w:body></w:document>';
test('deflated Word正文段落、表格、XML entities',()=>{const out=extractDocxText(zipDocx(xml));assert.match(out.text,/第一段 & 修正/);assert.match(out.text,/欄一/);assert.match(out.text,/欄二/);assert.match(out.text,/完畢/);});
test('uncompressed Word',()=>assert.match(extractDocxText(zipDocx(xml,false)).text,/第一段/));
test('non-zip rejected',()=>assert.throws(()=>extractDocxText(Buffer.from('bad')),/DOCX_INVALID_ZIP/));
test('missing Word body rejected',()=>assert.throws(()=>extractDocxText(zipDocx('<w:document/>')),/DOCX_DOCUMENT_BODY_NOT_FOUND/));
test('oversized file rejected',()=>assert.throws(()=>extractDocxText(Buffer.alloc(MAX_DOCX_BYTES+1)),/DOCX_TOO_LARGE/));
test('empty document rejected',()=>assert.throws(()=>extractDocxText(zipDocx('<w:document><w:body><w:p/></w:body></w:document>')),/DOCX_NO_TEXT/));
