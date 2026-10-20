/** Minimal text-only DOCX reader: parses ZIP central directory, extracts word/document.xml.
 * No original file is written to disk or to D1. No embedded images, external refs or macros.
 */
import { inflateRawSync } from 'node:zlib';

export const MAX_DOCX_BYTES = 3 * 1024 * 1024;
const MAX_XML_BYTES = 4 * 1024 * 1024;
const MAX_DOCUMENT_TEXT = 50_000;
function fail(message) { throw new Error(message); }
function entityDecode(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,(raw,code)=>{
    const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
    if(code in entities)return entities[code];
    if(code[0]!=='#')return raw;
    const cp=code[1]?.toLowerCase()==='x'?parseInt(code.slice(2),16):parseInt(code.slice(1),10);
    return cp>0&&cp<=0x10ffff&&!(cp>=0xd800&&cp<=0xdfff)?String.fromCodePoint(cp):'';
  });
}
function cleanXml(xml) {
  const paragraphs=xml.match(/<w:body\b[^>]*>[\s\S]*?<\/w:body>/)?.[0];
  if(!paragraphs)fail('DOCX_DOCUMENT_BODY_NOT_FOUND');
  const marked=paragraphs.replace(/<!--[\s\S]*?-->/g,'');
  const tokens=[];
  const tokenRx=/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?\s*>|<w:(?:br|cr)\b[^>]*\/?\s*>|<\/w:p\s*>|<\/w:tc\s*>|<\/w:tr\s*>/g;
  for(const m of marked.matchAll(tokenRx)) {
    if(m[1]!==undefined)tokens.push(entityDecode(m[1]));
    else if(/^<\/w:p/i.test(m[0])||/^<\/w:tr/i.test(m[0]))tokens.push('\n');
    else if(/^<\/w:tc/i.test(m[0])||/^<w:tab/i.test(m[0]))tokens.push('\t');
    else tokens.push('\n');
  }
  return tokens.join('').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function unzipXml(bytes) {
  if(bytes.length>MAX_DOCX_BYTES)fail('DOCX_TOO_LARGE');
  const b=Buffer.from(bytes);
  let eocd=-1;
  for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--){if(b.readUInt32LE(i)===0x06054b50){eocd=i;break;}}
  if(eocd<0)fail('DOCX_INVALID_ZIP');
  const count=b.readUInt16LE(eocd+10),start=b.readUInt32LE(eocd+16);
  if(count>2000||start>b.length)fail('DOCX_INVALID_ZIP');
  let cur=start;
  for(let i=0;i<count;i++){
    if(cur+46>b.length||b.readUInt32LE(cur)!==0x02014b50)fail('DOCX_INVALID_DIRECTORY');
    const flags=b.readUInt16LE(cur+8),method=b.readUInt16LE(cur+10);
    const size=b.readUInt32LE(cur+20),expanded=b.readUInt32LE(cur+24);
    const nameLength=b.readUInt16LE(cur+28),extra=b.readUInt16LE(cur+30),comment=b.readUInt16LE(cur+32),offset=b.readUInt32LE(cur+42);
    const end=cur+46+nameLength+extra+comment;
    if(end>b.length)fail('DOCX_INVALID_DIRECTORY');
    const name=b.toString('utf8',cur+46,cur+46+nameLength);
    cur=end;
    if(name!=='word/document.xml')continue;
    if(flags&1||size>MAX_DOCX_BYTES||expanded>MAX_XML_BYTES||offset+30>b.length)fail('DOCX_UNSUPPORTED_OR_OVERSIZED');
    if(b.readUInt32LE(offset)!==0x04034b50)fail('DOCX_INVALID_LOCAL_HEADER');
    const dataStart=offset+30+b.readUInt16LE(offset+26)+b.readUInt16LE(offset+28);
    if(dataStart+size>b.length)fail('DOCX_TRUNCATED');
    const compressed=b.subarray(dataStart,dataStart+size);
    let raw;
    if(method===0)raw=compressed;
    else if(method===8)raw=inflateRawSync(compressed,{maxOutputLength:MAX_XML_BYTES});
    else fail('DOCX_COMPRESSION_NOT_SUPPORTED');
    if(raw.length!==expanded||raw.length>MAX_XML_BYTES)fail('DOCX_UNPACK_SIZE_MISMATCH');
    return raw.toString('utf8');
  }
  fail('DOCX_DOCUMENT_XML_NOT_FOUND');
}
export function extractDocxText(bytes) {
  const xml=unzipXml(bytes);
  const text=cleanXml(xml);
  if(!text)fail('DOCX_NO_TEXT');
  if(text.length>MAX_DOCUMENT_TEXT)fail('DOCX_EXTRACTED_TEXT_TOO_LONG');
  return { text, characters:text.length, warnings:['僅擷取正文文字及表格文字；圖片、圖形、註解、頁首頁尾與排版不保留。'] };
}
