// password gate page — kept out of the HTML so the Content-Security-Policy can forbid inline scripts
  const f=document.getElementById('f'),pw=document.getElementById('pw'),err=document.getElementById('err'),go=document.getElementById('go');
  f.onsubmit=async(e)=>{e.preventDefault();go.disabled=true;err.textContent='';
    try{const r=await fetch('/api/gate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:pw.value})});const j=await r.json();
      if(r.ok){location.replace(location.pathname==='/gate.html'?'/':location.href);return;}
      err.textContent=j.error||'wrong password';}catch{err.textContent='network error';}
    go.disabled=false;};
