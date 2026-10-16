//! The engine bridge's UDP side in the shell: datagrams are received on their own thread and stamped on arrival, so a
//! long frame on the page's main thread can delay when a sample is read but not the time it is known to have arrived.
//! One socket per port for the life of the shell; a page that reloads and listens again takes over the delivery.
use std::collections::HashMap;
use std::net::UdpSocket;
use std::sync::{Arc, Mutex, OnceLock};

type Deliver = Arc<Mutex<Box<dyn FnMut(String) + Send>>>;
static LISTENERS: OnceLock<Mutex<HashMap<u16, Deliver>>> = OnceLock::new();

pub fn listen(port: u16, deliver: impl FnMut(String) + Send + 'static) -> std::io::Result<()> {
    let mut map = LISTENERS.get_or_init(Default::default).lock().unwrap();
    if let Some(d) = map.get(&port) { *d.lock().unwrap() = Box::new(deliver); return Ok(()); }
    let sock = UdpSocket::bind(("127.0.0.1", port))?;
    let d: Deliver = Arc::new(Mutex::new(Box::new(deliver)));
    map.insert(port, d.clone());
    std::thread::Builder::new().name(format!("bridge-udp-{port}")).spawn(move || {
        let mut buf = vec![0u8; 65536];
        loop {
            let Ok((n, _from)) = sock.recv_from(&mut buf) else { break };
            let rx = super::epoch_ms();
            let Ok(mut v) = serde_json::from_slice::<serde_json::Value>(&buf[..n]) else { continue };
            if let Some(o) = v.as_object_mut() { o.insert("rx_native".into(), rx.into()); }
            (d.lock().unwrap())(v.to_string());
        }
    })?;
    Ok(())
}
