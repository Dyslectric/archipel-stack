use crate::Config;
use sha2::{Digest, Sha256};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
};

struct Worker {
    child: Child,
    port: u16,
    pid: u32,
}
pub struct Workers {
    config: Config,
    slots: Vec<Mutex<Worker>>,
}
async fn spawn() -> Result<Worker, Box<dyn std::error::Error>> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().ok_or("Worker has no stdout")?;
    let mut line = String::new();
    tokio::time::timeout(
        Duration::from_secs(30),
        BufReader::new(stdout).read_line(&mut line),
    )
    .await??;
    let ready: serde_json::Value = serde_json::from_str(&line)?;
    let port = ready["port"]
        .as_u64()
        .and_then(|n| u16::try_from(n).ok())
        .ok_or("Invalid worker port")?;
    let pid = ready["pid"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .ok_or("Invalid worker PID")?;
    Ok(Worker { child, port, pid })
}
impl Workers {
    pub async fn start(config: Config) -> Result<Self, Box<dyn std::error::Error>> {
        let mut slots = Vec::new();
        for _ in 0..config.workers {
            slots.push(Mutex::new(spawn().await?));
        }
        Ok(Self { config, slots })
    }
    pub async fn port(&self, channel: &str) -> Result<u16, Box<dyn std::error::Error>> {
        let digest = Sha256::digest(channel.as_bytes());
        let index = u64::from_be_bytes(digest[..8].try_into()?) as usize % self.config.workers;
        let mut worker = self.slots[index].lock().await;
        if worker.child.try_wait()?.is_some() {
            *worker = spawn().await?;
        }
        Ok(worker.port)
    }
    pub async fn pids(&self) -> Vec<u32> {
        let mut pids = Vec::new();
        for slot in &self.slots {
            pids.push(slot.lock().await.pid);
        }
        pids
    }
    pub async fn ports(&self) -> Result<Vec<u16>, Box<dyn std::error::Error>> {
        let mut ports = Vec::new();
        for slot in &self.slots {
            let mut worker = slot.lock().await;
            if worker.child.try_wait()?.is_some() {
                *worker = spawn().await?;
            }
            ports.push(worker.port);
        }
        Ok(ports)
    }
    pub async fn stop(&self) {
        for slot in &self.slots {
            let mut worker = slot.lock().await;
            let _ = worker.child.kill().await;
            let _ = worker.child.wait().await;
        }
    }
}
