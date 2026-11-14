package in.creativemathzone.cmz;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Our own small plugin (printing / Save as PDF). Must be registered before super.onCreate.
        registerPlugin(PrintPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
