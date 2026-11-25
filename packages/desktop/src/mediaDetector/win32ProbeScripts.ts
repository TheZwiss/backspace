/**
 * Long-lived Windows SMTC monitor.
 *
 * WinRT is initialized once per process. Sessions and playback status are read
 * every 500 ms, but output is emitted only when the relevant state changes,
 * plus a slow heartbeat so the Electron side can detect a hung helper.
 */
export const SMTC_MONITOR_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$writer = [Console]::Out;
$writer.AutoFlush = $true;

try {
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null;
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null;
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue;

  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
  })[0];
  if (-not $asTask) { throw 'WinRT AsTask adapter was not found'; }

  function Await-WinRT($operation, $type) {
    if (-not $operation) { return $null; }
    try {
      return $operation.GetAwaiter().GetResult();
    } catch {
      $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation));
      if (-not $task.Wait(3000)) { throw 'WinRT operation timed out'; }
      return $task.Result;
    }
  }

  $manager = $null;
  $lastSignature = '';
  $lastEmitAt = [DateTime]::MinValue;
  $netEaseCheckAt = [DateTime]::MinValue;
  $netEaseRunning = $false;
  $netEaseWindowTitle = '';

  while ($true) {
    try {
      if (-not $manager) {
        $manager = Await-WinRT (
          [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
        ) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]);
      }
      if (-not $manager) { throw 'SMTC session manager is unavailable'; }

      $netEaseCheckDue = ([DateTime]::UtcNow - $netEaseCheckAt).TotalSeconds -ge 2;
      if ($netEaseCheckDue) {
        try {
          $netEaseProcess = Get-Process -Name cloudmusic -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 0 } |
            Select-Object -First 1;
          if (-not $netEaseProcess) {
            $netEaseProcess = Get-Process -Name cloudmusic -ErrorAction SilentlyContinue |
              Select-Object -First 1;
          }
          $netEaseRunning = [bool]$netEaseProcess;
          $netEaseWindowTitle = if ($netEaseProcess) {
            [string]$netEaseProcess.MainWindowTitle
          } else {
            ''
          };
        } catch {
          $netEaseRunning = $false;
          $netEaseWindowTitle = '';
        }
        $netEaseCheckAt = [DateTime]::UtcNow;
      }

      $sessions = @();
      $signatureParts = @();

      foreach ($session in $manager.GetSessions()) {
        $appId = '';
        $status = -1;
        $title = '';
        $artist = '';
        $mediaType = 'music';
        $positionMs = 0;
        $durationMs = 0;
        $timelineUpdatedAtMs = 0;

        try { $appId = [string]$session.SourceAppUserModelId } catch {}
        try {
          $playback = $session.GetPlaybackInfo();
          $status = [int]$playback.PlaybackStatus;
          if ($playback.PlaybackType -and [int]$playback.PlaybackType -eq 2) {
            $mediaType = 'video';
          }
        } catch {}

        if ($status -eq 4) {
          try {
            $properties = Await-WinRT (
              $session.TryGetMediaPropertiesAsync()
            ) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]);
            if ($properties) {
              if ($properties.Title) { $title = [string]$properties.Title }
              if ($properties.Artist) { $artist = [string]$properties.Artist }
            }
          } catch {}
          try {
            $timeline = $session.GetTimelineProperties();
            $positionMs = [long][Math]::Round($timeline.Position.TotalMilliseconds);
            $durationMs = [long][Math]::Round(($timeline.EndTime - $timeline.StartTime).TotalMilliseconds);
            $timelineUpdatedAtMs = [long]$timeline.LastUpdatedTime.ToUnixTimeMilliseconds();
          } catch {}
        }

        $sessions += [pscustomobject]@{
          appId = $appId;
          status = $status;
          title = $title;
          artist = $artist;
          mediaType = $mediaType;
          positionMs = $positionMs;
          durationMs = $durationMs;
          timelineUpdatedAtMs = $timelineUpdatedAtMs;
        }
        $signatureParts += (
          $appId + ':' + $status + ':' + $title + ':' + $artist + ':' +
          $mediaType + ':' + $timelineUpdatedAtMs
        );
      }

      $signature = (
        ($signatureParts -join '|') + '|netease:' + $netEaseRunning + ':' + $netEaseWindowTitle
      );
      $heartbeatDue = ([DateTime]::UtcNow - $lastEmitAt).TotalSeconds -ge 5;
      if ($signature -ne $lastSignature -or $heartbeatDue) {
        $message = [pscustomobject]@{
          ok = $true;
          sessions = @($sessions);
          netEase = [pscustomobject]@{
            running = $netEaseRunning;
            windowTitle = $netEaseWindowTitle;
          };
        } |
          ConvertTo-Json -Compress -Depth 5;
        $writer.WriteLine($message);
        $lastSignature = $signature;
        $lastEmitAt = [DateTime]::UtcNow;
      }
    } catch {
      $manager = $null;
      $message = ([string]$_.Exception.Message) -replace '[\\r\\n]+', ' ';
      $writer.WriteLine((
        [pscustomobject]@{ ok = $false; sessions = @(); error = $message } |
          ConvertTo-Json -Compress -Depth 5
      ));
      Start-Sleep -Milliseconds 1000;
      continue;
    }

    Start-Sleep -Milliseconds 500;
  }
} catch {
  $message = ([string]$_.Exception.Message) -replace '[\\r\\n]+', ' ';
  $writer.WriteLine((
    [pscustomobject]@{ ok = $false; sessions = @(); error = $message } |
      ConvertTo-Json -Compress -Depth 5
  ));
  exit 1;
}
`.trim();
