'use strict';
// Serves the published docs/ files to the browser tests; returns false for anything else.
const fs=require('node:fs'),path=require('node:path');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'};
exports.serveDocs=(req,res)=>{
 const name=files[new URL(req.url,'http://local').pathname];
 if(!name)return false;
 res.writeHead(200,{'content-type':types[path.extname(name)]});
 res.end(fs.readFileSync(path.join(__dirname,'../docs',name)));
 return true;
};
