; Lets colleagues reach this app on office networks, without a firewall prompt each user can't approve.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall add rule name="Beacon" dir=in action=allow program="$INSTDIR\Beacon.exe" enable=yes profile=domain,private'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Beacon"'
!macroend
