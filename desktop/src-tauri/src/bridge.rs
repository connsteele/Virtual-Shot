//! The engine bridge's UDP side in the shell: datagrams are received on their own thread and stamped on arrival, so a
//! long frame on the page's main thread can delay when a sample is read but not the time it is known to have arrived.
use std::net::UdpSocket;

pub fn listen(port: u16, mut deliver: impl FnMut(String) + Send + 'static) -> std::io::Result<()> {
    let sock = UdpSocket::bind(("127.0.0.1", port))?;
    std::thread::Builder::new().name(format!("bridge-udp-{port}")).spawn(move || {
        let mut buf = vec![0u8; 65536];
        loop {
            let Ok((n, _from)) = sock.recv_from(&mut buf) else { break };
            let rx = super::epoch_ms();
            let Ok(mut v) = serde_json::from_slice::<serde_json::Value>(&buf[..n]) else { continue };
            if let Some(o) = v.as_object_mut() { o.insert("rx_native".into(), rx.into()); }
            deliver(v.to_string());
        }
    })?;
    Ok(())
}
